/**
 * Bounded, allow-listed serialization for telemetry and persisted raw records.
 *
 * Telemetry is often exported outside the problem directory, so this module
 * treats every payload as potentially sensitive. It preserves useful metadata
 * while replacing source text, secret values, outside-root paths, and default
 * inputs with safe references.
 */

import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { TelemetryData, TelemetryValue } from "./event.js";

/** Default maximum number of characters retained in a telemetry string. */
export const DEFAULT_TELEMETRY_TEXT_LIMIT = 1_024;

/** Default maximum nesting depth retained from an untrusted event payload. */
export const DEFAULT_TELEMETRY_DEPTH_LIMIT = 8;

/** Environment variable values which are safe to include in telemetry. */
export const TELEMETRY_ENVIRONMENT_ALLOW_LIST = new Set([
  "PATH",
  "LANG",
  "PYTHONUNBUFFERED",
  "UV_CACHE_DIR",
]);

/** Policy controlling safe telemetry payload serialization. */
export interface TelemetryRedactionPolicy {
  /** Absolute root against which path values are made problem-relative. */
  readonly problemRoot: string;
  /** Whether an explicit caller authorized retaining bounded input text. */
  readonly verboseInput?: boolean;
  /** Maximum retained string length. Defaults to 1,024 characters. */
  readonly maxTextLength?: number;
  /** Maximum payload nesting depth. Defaults to 8. */
  readonly maxDepth?: number;
}

/**
 * Redact and bound arbitrary event payload data into the schema-v1 JSON shape.
 *
 * Inputs are represented as a SHA-256 reference unless `verboseInput` is
 * explicitly enabled. Environment values are retained only for the documented
 * child-process allow-list; source-like fields and secret-like names never
 * retain their values.
 *
 * @param data - Potentially untrusted event data.
 * @param policy - Problem-root and output-boundary policy.
 * @returns Safe, JSON-serializable telemetry data.
 */
export function redactTelemetryData(
  data: Readonly<Record<string, unknown>>,
  policy: TelemetryRedactionPolicy,
): TelemetryData {
  const maxTextLength = policy.maxTextLength ?? DEFAULT_TELEMETRY_TEXT_LIMIT;
  const maxDepth = policy.maxDepth ?? DEFAULT_TELEMETRY_DEPTH_LIMIT;
  assertPositiveSafeInteger(maxTextLength, "maxTextLength");
  assertPositiveSafeInteger(maxDepth, "maxDepth");

  const seen = new WeakSet<object>();
  const output: Record<string, TelemetryValue> = {};
  for (const [key, value] of Object.entries(data)) {
    output[key] = redactValue(
      value,
      key,
      policy,
      maxTextLength,
      maxDepth,
      0,
      seen,
    );
  }
  return Object.freeze(output);
}

/**
 * Return an input reference safe to put in logs or persistence records.
 *
 * @param input - Canonical input bytes or text.
 * @param verboseInput - Explicit authorization to retain a bounded rendering.
 * @param maxTextLength - Maximum length for verbose text.
 * @returns A content hash by default, or a bounded text rendering when enabled.
 */
export function redactInput(
  input: Uint8Array | string,
  verboseInput = false,
  maxTextLength = DEFAULT_TELEMETRY_TEXT_LIMIT,
): TelemetryValue {
  assertPositiveSafeInteger(maxTextLength, "maxTextLength");
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (!verboseInput) {
    return Object.freeze({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    });
  }
  return typeof input === "string"
    ? truncate(input, maxTextLength)
    : truncate(Buffer.from(input).toString("utf8"), maxTextLength);
}

function redactValue(
  value: unknown,
  key: string,
  policy: TelemetryRedactionPolicy,
  maxTextLength: number,
  maxDepth: number,
  depth: number,
  seen: WeakSet<object>,
): TelemetryValue {
  if (isSecretKey(key) || isSourceKey(key)) {
    return "[redacted]";
  }
  if (
    isInputKey(key) &&
    (typeof value === "string" || value instanceof Uint8Array)
  ) {
    return redactInput(value, policy.verboseInput, maxTextLength);
  }
  if (isPathKey(key) && typeof value === "string") {
    return normalizeProblemPath(value, policy.problemRoot);
  }
  if (key === "environment" && isRecord(value)) {
    return redactEnvironment(value, maxTextLength);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return truncate(value, maxTextLength);
  }
  if (value instanceof Uint8Array) {
    return Object.freeze({
      bytes: value.byteLength,
      value: "[binary redacted]",
    });
  }
  if (depth >= maxDepth || typeof value !== "object") {
    return "[redacted]";
  }
  if (seen.has(value)) {
    return "[redacted circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) =>
        redactValue(
          item,
          key,
          policy,
          maxTextLength,
          maxDepth,
          depth + 1,
          seen,
        ),
      ),
    );
  }
  if (isRecord(value)) {
    const output: Record<string, TelemetryValue> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactValue(
        childValue,
        childKey,
        policy,
        maxTextLength,
        maxDepth,
        depth + 1,
        seen,
      );
    }
    return Object.freeze(output);
  }
  return "[redacted]";
}

function redactEnvironment(
  environment: Record<string, unknown>,
  maxTextLength: number,
): TelemetryValue {
  const output: Record<string, TelemetryValue> = {};
  for (const [key, value] of Object.entries(environment)) {
    output[key] =
      TELEMETRY_ENVIRONMENT_ALLOW_LIST.has(key) && typeof value === "string"
        ? truncate(value, maxTextLength)
        : "[redacted]";
  }
  return Object.freeze(output);
}

/** Normalize an absolute path only when it remains within the problem root. */
export function normalizeProblemPath(
  path: string,
  problemRoot: string,
): string {
  const root = resolve(problemRoot);
  const candidate = resolve(path);
  const relativePath = relative(root, candidate);
  if (relativePath === "") {
    return ".";
  }
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return "[redacted path]";
  }
  return relativePath.split(sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return /(?:secret|token|password|passwd|credential|api[_-]?key|authorization)/i.test(
    key,
  );
}

function isSourceKey(key: string): boolean {
  return /(?:source|code|script|contents?)/i.test(key);
}

function isInputKey(key: string): boolean {
  return /(?:^|_)(?:input|stdin)(?:$|_)/i.test(key);
}

function isPathKey(key: string): boolean {
  return /(?:^|_)(?:path|file|directory|root)(?:$|_)/i.test(key);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}
