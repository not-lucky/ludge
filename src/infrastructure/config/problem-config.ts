/**
 * `problem.yaml` schema v1 loader.
 *
 * Turns a parsed {@link YamlNode} (or raw YAML text) into a validated, frozen
 * {@link ProblemConfig}. Validation is strict and fail-closed per the CLI
 * contract: unknown fields, wrong types, missing required fields, malformed
 * slugs, non-integer or out-of-range limits, and duplicate keys (rejected by the
 * parser) are all errors — never silently ignored. Any failure is a
 * {@link ProblemConfigError}, which the CLI maps to exit code 3.
 *
 * Two things are deliberately left raw here and resolved later, where the
 * invocation/problem roots are known (see `precedence.ts`): the `limits` field
 * is captured as a *partial* override map (so env and CLI can still layer on top
 * before a single validated {@link ResourceLimits} is built), and the path-like
 * fields (`entrypoint`, `casesDir`, `generator`, `naive`) are kept as their
 * declared relative strings rather than being resolved to absolute paths.
 */

import type { ResourceLimitsSpec } from "../../domain/index.js";
import { ProblemConfigError } from "./errors.js";
import { isValidSlug } from "./slug.js";
import {
  DEFAULT_CASES_DIR,
  DEFAULT_COMPARISON_POLICY,
  DEFAULT_INPUT_CODEC,
  DEFAULT_OUTPUT_CODEC,
  DEFAULT_RUNTIME,
  SUPPORTED_SCHEMA_VERSION,
} from "./defaults.js";
import { parseYaml, type YamlNode } from "./yaml.js";

/** A partial set of resource-limit overrides declared by a problem. */
export type ProblemLimitOverrides = Partial<ResourceLimitsSpec>;

/**
 * A validated, frozen `problem.yaml` (schema v1).
 *
 * Path-like fields (`entrypoint`, `casesDir`, `generator`, `naive`) hold the
 * declared relative strings; they are resolved and confined to the problem root
 * during effective-configuration resolution. `limits` holds only the keys the
 * problem overrode, to be merged over the built-in defaults later.
 */
export interface ProblemConfig {
  /** Schema version; always {@link SUPPORTED_SCHEMA_VERSION} for this build. */
  readonly schemaVersion: number;
  /** Lowercase kebab-case problem identifier. */
  readonly slug: string;
  /** Human-facing problem title. */
  readonly title: string;
  /** Target entry script, relative to the problem root. */
  readonly entrypoint: string;
  /** Runtime identifier (e.g. `"python-uv"`). */
  readonly runtime: string;
  /** Input value-framing codec version. */
  readonly inputCodec: string;
  /** Output value-framing codec version. */
  readonly outputCodec: string;
  /** Comparison-policy version (e.g. `"exact-v1"`). */
  readonly comparisonPolicy: string;
  /** Resource-limit overrides declared by the problem (may be empty). */
  readonly limits: ProblemLimitOverrides;
  /** Test-case directory, relative to the problem root. */
  readonly casesDir: string;
  /** Optional generator script (relative to the problem root). */
  readonly generator?: string;
  /** Optional naive/reference script (relative to the problem root). */
  readonly naive?: string;
  /** Optional class-protocol descriptor, or `null` when absent. */
  readonly classProtocol?: string | null;
}

/** Every field name `problem.yaml` may contain; any other key is rejected. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "slug",
  "title",
  "entrypoint",
  "runtime",
  "inputCodec",
  "outputCodec",
  "comparisonPolicy",
  "limits",
  "casesDir",
  "generator",
  "naive",
  "classProtocol",
]);

/**
 * The resource-limit field names accepted inside a `limits` map. Mirrors the
 * field set of the domain `ResourceLimits`; an unknown limit key is rejected.
 */
const LIMIT_FIELD_NAMES: readonly (keyof ResourceLimitsSpec)[] = [
  "wallTimeMs",
  "cpuTimeMs",
  "memoryBytes",
  "stdoutBytes",
  "stderrBytes",
  "combinedOutputBytes",
  "inputBytes",
  "fileSizeBytes",
  "processCount",
  "openDescriptors",
  "tempStorageBytes",
  "concurrencyPerCase",
];

/**
 * Parse and validate `problem.yaml` text into a {@link ProblemConfig}.
 *
 * @param text - The raw `problem.yaml` document.
 * @returns The validated, frozen problem configuration.
 * @throws {ProblemConfigError} If the document is malformed or fails schema v1.
 */
export function loadProblemConfig(text: string): ProblemConfig {
  const parsed = parseYaml(text);
  if (!parsed.ok) {
    throw new ProblemConfigError(
      `malformed problem.yaml (line ${parsed.error.line}): ${parsed.error.message}`,
    );
  }
  return parseProblemConfig(parsed.node);
}

/**
 * Validate an already-parsed YAML node into a {@link ProblemConfig}.
 *
 * @param node - The root node produced by {@link parseYaml}.
 * @returns The validated, frozen problem configuration.
 * @throws {ProblemConfigError} If the root is not a mapping, a field has the
 *   wrong type, a required field is missing, or a value is out of range.
 */
export function parseProblemConfig(node: YamlNode): ProblemConfig {
  if (node.kind !== "map") {
    throw new ProblemConfigError("problem.yaml root must be a mapping");
  }
  const entries = node.entries;

  for (const key of entries.keys()) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new ProblemConfigError(`unknown field '${key}'`);
    }
  }

  const schemaVersion = requireInt(entries, "schemaVersion");
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new ProblemConfigError(
      `unsupported schemaVersion ${schemaVersion}; this build supports ${SUPPORTED_SCHEMA_VERSION}`,
      "schemaVersion",
    );
  }

  const slug = requireString(entries, "slug");
  if (!isValidSlug(slug)) {
    throw new ProblemConfigError(
      `malformed slug ${JSON.stringify(slug)}; expected lowercase kebab-case`,
      "slug",
    );
  }

  const config: Mutable<ProblemConfig> = {
    schemaVersion,
    slug,
    title: requireString(entries, "title"),
    entrypoint: requireString(entries, "entrypoint"),
    runtime: optionalString(entries, "runtime") ?? DEFAULT_RUNTIME,
    inputCodec: optionalString(entries, "inputCodec") ?? DEFAULT_INPUT_CODEC,
    outputCodec: optionalString(entries, "outputCodec") ?? DEFAULT_OUTPUT_CODEC,
    comparisonPolicy:
      optionalString(entries, "comparisonPolicy") ?? DEFAULT_COMPARISON_POLICY,
    limits: parseLimits(entries.get("limits")),
    casesDir: optionalString(entries, "casesDir") ?? DEFAULT_CASES_DIR,
  };

  const generator = optionalString(entries, "generator");
  if (generator !== undefined) {
    config.generator = generator;
  }
  const naive = optionalString(entries, "naive");
  if (naive !== undefined) {
    config.naive = naive;
  }
  const classProtocol = parseClassProtocol(entries.get("classProtocol"));
  if (classProtocol !== NO_CLASS_PROTOCOL) {
    config.classProtocol = classProtocol;
  }

  return Object.freeze(config);
}

/** A writable view used only while assembling an immutable config. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Sentinel meaning `classProtocol` was absent (distinct from an explicit null). */
const NO_CLASS_PROTOCOL = Symbol("no-class-protocol");

/** Require a present string field, rejecting a missing or non-string value. */
function requireString(
  entries: ReadonlyMap<string, YamlNode>,
  field: string,
): string {
  const value = optionalString(entries, field);
  if (value === undefined) {
    throw new ProblemConfigError("required field is missing", field);
  }
  return value;
}

/** Read an optional string field, rejecting a present-but-non-string value. */
function optionalString(
  entries: ReadonlyMap<string, YamlNode>,
  field: string,
): string | undefined {
  const node = entries.get(field);
  if (node === undefined) {
    return undefined;
  }
  if (node.kind !== "string") {
    throw new ProblemConfigError(`expected a string`, field);
  }
  if (node.value.length === 0) {
    throw new ProblemConfigError("must not be empty", field);
  }
  return node.value;
}

/** Require a present integer field, bounded before numeric conversion. */
function requireInt(
  entries: ReadonlyMap<string, YamlNode>,
  field: string,
): number {
  const node = entries.get(field);
  if (node === undefined) {
    throw new ProblemConfigError("required field is missing", field);
  }
  if (node.kind !== "int") {
    throw new ProblemConfigError("expected an integer", field);
  }
  return toBoundedInt(node.raw, field);
}

/**
 * Convert a raw integer token to a number, bounding it first.
 *
 * The token was already shape-validated by the parser; here it is rejected if
 * it would not survive as an exact JavaScript integer, so a value silently
 * losing precision never reaches a limit or version check.
 */
function toBoundedInt(raw: string, field: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ProblemConfigError(
      `integer ${raw} is outside the safe range`,
      field,
    );
  }
  return value;
}

/**
 * Parse the `limits` field into a partial override map.
 *
 * `limits` must be a mapping (`{}` yields no overrides). Each entry's key must
 * be a known limit and its value a positive integer; anything else is rejected
 * with a field-anchored message. The overrides stay partial so env and CLI tiers
 * can still layer on before a single validated `ResourceLimits` is built.
 */
function parseLimits(node: YamlNode | undefined): ProblemLimitOverrides {
  if (node === undefined) {
    throw new ProblemConfigError("required field is missing", "limits");
  }
  if (node.kind !== "map") {
    throw new ProblemConfigError("expected a mapping", "limits");
  }

  const overrides: Record<string, number> = {};
  for (const [key, valueNode] of node.entries) {
    if (!LIMIT_FIELD_NAMES.includes(key as keyof ResourceLimitsSpec)) {
      throw new ProblemConfigError(`unknown limit '${key}'`, "limits");
    }
    const fieldPath = `limits.${key}`;
    if (valueNode.kind !== "int") {
      throw new ProblemConfigError("expected an integer", fieldPath);
    }
    const value = toBoundedInt(valueNode.raw, fieldPath);
    if (value <= 0) {
      throw new ProblemConfigError(
        "resource limits must be positive integers",
        fieldPath,
      );
    }
    overrides[key] = value;
  }
  return overrides;
}

/**
 * Parse the optional `classProtocol` field (a string or explicit null).
 *
 * Returns the {@link NO_CLASS_PROTOCOL} sentinel when the field is absent, so
 * the caller can distinguish "not declared" from an explicit `null` value.
 */
function parseClassProtocol(
  node: YamlNode | undefined,
): string | null | typeof NO_CLASS_PROTOCOL {
  if (node === undefined) {
    return NO_CLASS_PROTOCOL;
  }
  if (node.kind === "null") {
    return null;
  }
  if (node.kind === "string" && node.value.length > 0) {
    return node.value;
  }
  throw new ProblemConfigError(
    "expected a non-empty string or null",
    "classProtocol",
  );
}
