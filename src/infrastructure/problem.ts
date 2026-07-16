/**
 * The complete external configuration boundary for a problem run.
 *
 * Palestra has one runtime, one wire format, and one comparator. `problem.yaml`
 * therefore describes the problem, not a plug-in graph. This module parses that
 * untrusted document, resolves the paths it names, and creates the one trusted
 * configuration shape used by application code.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  realpath as nodeRealpath,
  readFile,
  stat,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  createResourceLimits,
  type ResourceLimits,
  type ResourceLimitsSpec,
} from "../domain/limits.js";

export const PROBLEM_SCHEMA_VERSION = 1;
export const INPUT_CODEC_VERSION = "tagged-jsonl-v1";
export const OUTPUT_CODEC_VERSION = "tagged-jsonl-v1";
export const COMPARISON_POLICY_VERSION = "exact-v1";
export const DEFAULT_CASES_DIR = "cases";
export const PROBLEM_STATEMENT_FILE = "problem.md";
export const isValidSlug = (slug: string) =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug);

export const DEFAULT_LIMITS: ResourceLimitsSpec = {
  wallTimeMs: 2_000,
  cpuTimeMs: 2_000,
  memoryBytes: 268_435_456,
  stdoutBytes: 1_048_576,
  stderrBytes: 1_048_576,
  combinedOutputBytes: 2_097_152,
  inputBytes: 4_194_304,
  fileSizeBytes: 8_388_608,
  processCount: 64,
  openDescriptors: 256,
  tempStorageBytes: 67_108_864,
  concurrencyPerCase: 1,
};

export class ProblemError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProblemError";
  }
}

/** The closed, LeetCode-only type grammar declared by a problem. */
export type LeetType =
  | { readonly kind: "int" | "float" | "str" | "bool" | "null" }
  | { readonly kind: "list"; readonly item: LeetType }
  | { readonly kind: "ListNode" | "TreeNode"; readonly item: LeetType };

interface ProblemBase {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly title: string;
  readonly entrypoint: string;
  readonly casesDir: string;
  readonly generator?: string;
  readonly naive?: string;
  readonly limits: Partial<ResourceLimitsSpec>;
  readonly runtime: "python-uv";
  readonly inputCodec: "tagged-jsonl-v1";
  readonly outputCodec: "tagged-jsonl-v1";
  readonly comparisonPolicy: "exact-v1";
}

/** A function problem has only positional arguments and one declared result. */
export interface FunctionProblem extends ProblemBase {
  readonly kind: "function";
  readonly args: readonly LeetType[];
  readonly returns: LeetType;
}

/** A stateful LeetCode class problem declares every callable operation. */
export interface ClassProblem extends ProblemBase {
  readonly kind: "class";
  readonly className: string;
  readonly constructor: readonly LeetType[];
  readonly methods: Readonly<
    Record<
      string,
      { readonly args: readonly LeetType[]; readonly returns: LeetType }
    >
  >;
}

/** The small, user-authored `problem.yaml` document. */
export type Problem = FunctionProblem | ClassProblem;

/** Paths and fixed product policy after all untrusted configuration is consumed. */
export interface RunContext {
  readonly problemRoot: string;
  readonly problem: Problem;
  readonly limits: ResourceLimits;
  readonly assets: {
    readonly entrypoint: string;
    readonly casesDir: string;
    readonly statement: string;
    readonly generator?: string;
    readonly naive?: string;
  };
  readonly unsafeLocal: boolean;
  readonly stateDirectory: string;
  readonly cgroupParentPath: string;
  readonly uvPath: string;
  readonly pythonPath: string;
}

export interface LoadRunContextOptions {
  readonly invocationDirectory: string;
  readonly slug: string;
  readonly unsafeLocal: boolean;
  readonly solution?: string;
  readonly generator?: string;
  readonly naive?: string;
  /** Host locations; only PALESTRA_CGROUP_PARENT and PALESTRA_STATE_DIR are read. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Explicit test/embedding overrides for the two permitted host locations. */
  readonly cgroupParentPath?: string;
  readonly stateDirectory?: string;
  readonly readText?: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly resolveExecutable?: (
    name: "uv" | "python3",
  ) => Promise<string | undefined>;
  readonly isExecutable?: (path: string) => Promise<boolean>;
}

/** Parse a flat `problem.yaml` document. */
export function loadProblem(text: string): Problem {
  const result = parseYaml(text);
  if (!result.ok) {
    throw new ProblemError(
      `malformed problem.yaml (line ${result.error.line}): ${result.error.message}`,
    );
  }
  return parseProblem(result.node);
}

/** Create the trusted context shared by test, stress, benchmark, and replay. */
export async function loadRunContext(
  options: LoadRunContextOptions,
): Promise<RunContext> {
  const realpath = options.realpath ?? nodeRealpath;
  const readText =
    options.readText ?? ((path: string) => readFile(path, "utf8"));
  const problemRoot = await requiredRealpath(
    realpath,
    resolve(options.invocationDirectory, "problems", options.slug),
    `problem '${options.slug}'`,
  );
  const problem = loadProblem(
    await requiredText(readText, resolve(problemRoot, "problem.yaml")),
  );
  if (problem.slug !== options.slug) {
    throw new ProblemError(
      `problem.yaml slug does not match requested slug: ${problem.slug}`,
    );
  }

  const asset = (declared: string, override?: string): string =>
    override === undefined
      ? resolveProblemPath(problemRoot, declared)
      : resolveInvocationPath(options.invocationDirectory, override);
  const optionalAsset = (
    declared: string | undefined,
    override: string | undefined,
  ): string | undefined =>
    override === undefined && declared === undefined
      ? undefined
      : asset(declared ?? override!, override);
  const environment = options.environment ?? process.env;
  const stateDirectory = hostPath(
    options.stateDirectory ??
      environment.PALESTRA_STATE_DIR ??
      resolve(options.invocationDirectory, ".palestra"),
    options.invocationDirectory,
    "PALESTRA_STATE_DIR",
  );
  const cgroupParentPath = cgroupPath(
    options.cgroupParentPath ??
      environment.PALESTRA_CGROUP_PARENT ??
      "/sys/fs/cgroup/palestra",
  );
  const entrypoint = await confinedRealpath(
    realpath,
    asset(problem.entrypoint, options.solution),
    problemRoot,
    options.solution === undefined,
    "solution",
  );
  const casesDir = await confinedRealpath(
    realpath,
    resolveProblemPath(problemRoot, problem.casesDir),
    problemRoot,
    true,
    "cases directory",
  );
  const statement = await confinedRealpath(
    realpath,
    resolveProblemPath(problemRoot, PROBLEM_STATEMENT_FILE),
    problemRoot,
    true,
    "problem.md",
  );
  const generator = await optionalConfinedRealpath(
    realpath,
    optionalAsset(problem.generator, options.generator),
    problemRoot,
    options.generator === undefined,
    "generator",
  );
  const naive = await optionalConfinedRealpath(
    realpath,
    optionalAsset(problem.naive, options.naive),
    problemRoot,
    options.naive === undefined,
    "naive",
  );
  const resolveExecutable = options.resolveExecutable ?? findExecutable;
  const isExecutable = options.isExecutable ?? executableFile;
  const uvPath = await requiredExecutable(
    resolveExecutable,
    isExecutable,
    "uv",
  );
  const pythonPath = await requiredExecutable(
    resolveExecutable,
    isExecutable,
    "python3",
  );

  return {
    problemRoot,
    problem,
    limits: createResourceLimits({ ...DEFAULT_LIMITS, ...problem.limits }),
    assets: {
      entrypoint,
      casesDir,
      statement,
      ...(generator === undefined ? {} : { generator }),
      ...(naive === undefined ? {} : { naive }),
    },
    unsafeLocal: options.unsafeLocal,
    stateDirectory,
    cgroupParentPath,
    uvPath,
    pythonPath,
  };
}

export function parseProblem(node: YamlNode): Problem {
  if (node.kind !== "map")
    throw new ProblemError("problem.yaml root must be a mapping");
  const fields = node.entries;
  const shared = new Set([
    "schemaVersion",
    "slug",
    "title",
    "entrypoint",
    "casesDir",
    "generator",
    "naive",
    "limits",
  ]);
  const functionFields = new Set([...shared, "args", "returns"]);
  const classFields = new Set([...shared, "class", "constructor", "methods"]);
  const isClass = fields.has("class");
  for (const name of fields.keys()) {
    if (!(isClass ? classFields : functionFields).has(name))
      throw new ProblemError(`unknown field '${name}'`);
  }
  const schemaVersion = integer(fields, "schemaVersion");
  if (schemaVersion !== PROBLEM_SCHEMA_VERSION)
    throw new ProblemError(`unsupported schemaVersion ${schemaVersion}`);
  const slug = string(fields, "slug");
  if (!isValidSlug(slug))
    throw new ProblemError(`malformed slug ${JSON.stringify(slug)}`);
  const base: ProblemBase = {
    schemaVersion: PROBLEM_SCHEMA_VERSION,
    slug,
    title: string(fields, "title"),
    entrypoint: string(fields, "entrypoint"),
    casesDir: optionalString(fields, "casesDir") ?? DEFAULT_CASES_DIR,
    ...(optionalString(fields, "generator") === undefined
      ? {}
      : { generator: optionalString(fields, "generator")! }),
    ...(optionalString(fields, "naive") === undefined
      ? {}
      : { naive: optionalString(fields, "naive")! }),
    limits: limits(fields.get("limits")),
    runtime: "python-uv",
    inputCodec: INPUT_CODEC_VERSION,
    outputCodec: OUTPUT_CODEC_VERSION,
    comparisonPolicy: COMPARISON_POLICY_VERSION,
  };
  if (!isClass) {
    return {
      ...base,
      kind: "function",
      args: typeList(fields.get("args"), "args"),
      returns: typeOf(requiredNode(fields, "returns"), "returns"),
    };
  }
  return {
    ...base,
    kind: "class",
    className: string(fields, "class"),
    constructor: typeList(fields.get("constructor"), "constructor"),
    methods: methodsOf(requiredNode(fields, "methods")),
  };
}

function requiredNode(
  fields: ReadonlyMap<string, YamlNode>,
  name: string,
): YamlNode {
  const value = fields.get(name);
  if (value === undefined) throw new ProblemError(`${name} is required`);
  return value;
}
function typeList(
  value: YamlNode | undefined,
  name: string,
): readonly LeetType[] {
  if (value === undefined) throw new ProblemError(`${name} is required`);
  if (value.kind !== "list")
    throw new ProblemError(`${name} must be a flow list`);
  return Object.freeze(
    value.items.map((item, index) => typeOf(item, `${name}[${index}]`)),
  );
}
function typeOf(value: YamlNode, name: string): LeetType {
  if (value.kind === "null") return { kind: "null" };
  if (value.kind !== "string")
    throw new ProblemError(`${name} must be a type string`);
  const text = value.value;
  if (["int", "float", "str", "bool", "null"].includes(text))
    return { kind: text as "int" | "float" | "str" | "bool" | "null" };
  const list = /^list\[(.+)\]$/u.exec(text);
  if (list !== null) return { kind: "list", item: typeText(list[1]!, name) };
  if (text === "ListNode" || text === "TreeNode")
    return { kind: text, item: { kind: "int" } };
  const node = /^(ListNode|TreeNode)\[(.+)\]$/u.exec(text);
  if (node !== null)
    return {
      kind: node[1]! as "ListNode" | "TreeNode",
      item: typeText(node[2]!, name),
    };
  throw new ProblemError(
    `${name} has unsupported type ${JSON.stringify(text)}`,
  );
}
function typeText(text: string, name: string): LeetType {
  return typeOf({ kind: "string", value: text }, name);
}
function methodsOf(
  value: YamlNode,
): Readonly<
  Record<
    string,
    { readonly args: readonly LeetType[]; readonly returns: LeetType }
  >
> {
  if (value.kind !== "map" || value.entries.size === 0)
    throw new ProblemError("methods must be a non-empty mapping");
  const result: Record<
    string,
    { readonly args: readonly LeetType[]; readonly returns: LeetType }
  > = {};
  for (const [name, spec] of value.entries) {
    if (spec.kind !== "map")
      throw new ProblemError(`methods.${name} must be a mapping`);
    for (const key of spec.entries.keys())
      if (key !== "args" && key !== "returns")
        throw new ProblemError(`unknown field 'methods.${name}.${key}'`);
    result[name] = {
      args: typeList(spec.entries.get("args"), `methods.${name}.args`),
      returns: typeOf(
        requiredNode(spec.entries, "returns"),
        `methods.${name}.returns`,
      ),
    };
  }
  return Object.freeze(result);
}

function string(fields: ReadonlyMap<string, YamlNode>, name: string): string {
  const value = optionalString(fields, name);
  if (value === undefined) throw new ProblemError(`${name} is required`);
  return value;
}

function optionalString(
  fields: ReadonlyMap<string, YamlNode>,
  name: string,
): string | undefined {
  const value = fields.get(name);
  if (value === undefined) return undefined;
  if (value.kind !== "string" || value.value.length === 0) {
    throw new ProblemError(`${name} must be a non-empty string`);
  }
  return value.value;
}

function integer(fields: ReadonlyMap<string, YamlNode>, name: string): number {
  const value = fields.get(name);
  if (value?.kind !== "int")
    throw new ProblemError(`${name} must be an integer`);
  const result = Number(value.raw);
  if (!Number.isSafeInteger(result))
    throw new ProblemError(`${name} is outside the safe integer range`);
  return result;
}

function limits(value: YamlNode | undefined): Partial<ResourceLimitsSpec> {
  if (value === undefined) return {};
  if (value.kind !== "map") throw new ProblemError("limits must be a mapping");
  const result: { -readonly [K in keyof ResourceLimitsSpec]?: number } = {};
  for (const [name, node] of value.entries) {
    if (!(name in DEFAULT_LIMITS) || node.kind !== "int") {
      throw new ProblemError(`invalid limit '${name}'`);
    }
    const number = Number(node.raw);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new ProblemError(`limit '${name}' must be a positive safe integer`);
    }
    result[name as keyof ResourceLimitsSpec] = number;
  }
  return result;
}

function resolveInvocationPath(root: string, path: string): string {
  if (path.includes("\0")) throw new ProblemError("path contains a NUL byte");
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function hostPath(value: string, root: string, name: string): string {
  if (value.trim().length === 0)
    throw new ProblemError(`${name} must not be empty`);
  if (value.includes("\0"))
    throw new ProblemError(`${name} contains a NUL byte`);
  return resolve(root, value);
}

function cgroupPath(value: string): string {
  if (value.trim().length === 0) {
    throw new ProblemError("PALESTRA_CGROUP_PARENT must not be empty");
  }
  if (value.includes("\0") || !isAbsolute(value)) {
    throw new ProblemError("PALESTRA_CGROUP_PARENT must be an absolute path");
  }
  return resolve(value);
}

async function requiredText(
  readText: (path: string) => Promise<string>,
  path: string,
): Promise<string> {
  try {
    return await readText(path);
  } catch {
    throw new ProblemError(`cannot read problem.yaml: ${path}`);
  }
}

async function requiredRealpath(
  realpath: (path: string) => Promise<string>,
  path: string,
  label: string,
): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new ProblemError(`${label} does not exist: ${path}`);
  }
}

async function confinedRealpath(
  realpath: (path: string) => Promise<string>,
  path: string,
  problemRoot: string,
  mustStayInProblem: boolean,
  label: string,
): Promise<string> {
  const resolved = await requiredRealpath(realpath, path, label);
  if (mustStayInProblem) {
    const inside = relative(problemRoot, resolved);
    if (
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    ) {
      throw new ProblemError(`${label} escapes the problem root: ${path}`);
    }
  }
  return resolved;
}

async function optionalConfinedRealpath(
  realpath: (path: string) => Promise<string>,
  path: string | undefined,
  problemRoot: string,
  mustStayInProblem: boolean,
  label: string,
): Promise<string | undefined> {
  return path === undefined
    ? undefined
    : confinedRealpath(realpath, path, problemRoot, mustStayInProblem, label);
}

async function requiredExecutable(
  resolveExecutable: (name: "uv" | "python3") => Promise<string | undefined>,
  isExecutable: (path: string) => Promise<boolean>,
  name: "uv" | "python3",
): Promise<string> {
  const path = await resolveExecutable(name);
  if (path === undefined)
    throw new ProblemError(`${name} executable not found on PATH`);
  if (!(await isExecutable(path))) {
    throw new ProblemError(`${name} is not an executable file: ${path}`);
  }
  return path;
}

const execFileAsync = promisify(execFile);

async function findExecutable(
  name: "uv" | "python3",
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [name], {
      encoding: "utf8",
    });
    const path = stdout.trim();
    return path === "" ? undefined : path;
  } catch {
    return undefined;
  }
}

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function resolveProblemPath(root: string, path: string): string {
  const resolved = resolveInvocationPath(root, path);
  const inside = relative(root, resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new ProblemError(
      `path escapes the problem root: ${JSON.stringify(path)}`,
    );
  }
  return resolved;
}

// Strict YAML subset parser for the sole problem-file boundary.
/**
 * A strict, hand-rolled parser for the small YAML subset `problem.yaml` uses.
 *
 * The judge deliberately does NOT pull in a general YAML dependency (the project
 * ships zero runtime dependencies and hand-rolls its JSON reader for the same
 * reason). A full YAML engine would also accept far more than the problem schema
 * needs — anchors, tags, multi-document streams, block scalars — each an avenue
 * for surprising or unsafe configuration. This reader instead accepts a tightly
 * bounded block-mapping subset and treats everything outside it as an error.
 *
 * Supported constructs:
 *   - a root block mapping of `key: value` entries;
 *   - nested block mappings (used by `limits:`), indented with spaces;
 *   - scalars: plain and quoted strings, decimal integers, `true`/`false`,
 *     and `null`/`~`;
 *   - the empty flow map `{}` and compact flow lists (used exclusively by
 *     signature declarations);
 *   - `#` line comments and blank lines.
 *
 * Rejected as errors (never silently ignored): duplicate keys, tab indentation,
 * inconsistent indentation, non-empty flow collections, block scalars, anchors,
 * tags, and any other unsupported syntax.
 *
 * Like {@link parseJson}, this returns a result union for malformed input rather
 * than throwing, so callers treat a parse failure as ordinary control flow.
 */

/**
 * A parsed YAML value as a discriminated union.
 *
 * Integers retain their raw source text in `raw` (never converted to a JS
 * number here) so the schema loader can bound-check the digits before a lossy
 * numeric conversion. The root node returned by {@link parseYaml} is always a
 * `map`.
 */
export type YamlNode =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly raw: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "list"; readonly items: readonly YamlNode[] }
  | { readonly kind: "map"; readonly entries: ReadonlyMap<string, YamlNode> };

/** A structured description of where and why YAML parsing failed. */
export interface YamlParseError {
  /** Human-readable, bounded description of the failure. */
  readonly message: string;
  /** 1-based source line the error was detected on (`0` if not line-specific). */
  readonly line: number;
}

/** The result of {@link parseYaml}: the parsed root map or a structured error. */
export type YamlParseResult =
  | { readonly ok: true; readonly node: YamlNode }
  | { readonly ok: false; readonly error: YamlParseError };

/**
 * Maximum block-mapping nesting depth accepted.
 *
 * `problem.yaml` needs only one level of nesting (`limits:`), so this generous
 * bound simply guards against pathological input while leaving legitimate
 * documents unaffected.
 */
export const YAML_MAX_DEPTH = 16;

/** A single significant source line after comment stripping. */
interface PhysicalLine {
  /** Number of leading space characters (the indentation column). */
  readonly indent: number;
  /** The line content after the indent, comment-stripped and end-trimmed. */
  readonly text: string;
  /** 1-based source line number, for diagnostics. */
  readonly line: number;
}

/** Internal control-flow signal carrying a parse failure out of recursion. */
class YamlAbort extends Error {
  public constructor(
    public readonly detail: string,
    public readonly lineNo: number,
  ) {
    super(detail);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Parse a `problem.yaml`-style document under the strict subset grammar.
 *
 * Never throws for malformed input: any unsupported construct, structural
 * error, duplicate key, or tab-indented line is reported as
 * `{ ok: false, error }`. The root is always a mapping; a document whose root
 * is a scalar or list is rejected.
 *
 * @param text - The complete document text.
 * @returns A success result carrying the root `map` node, or a failure result
 *   carrying a {@link YamlParseError}.
 */
export function parseYaml(text: string): YamlParseResult {
  try {
    const lines = tokenizeLines(text);
    if (lines.length === 0) {
      // An empty document is an empty mapping.
      return { ok: true, node: { kind: "map", entries: new Map() } };
    }
    const first = lines[0];
    if (first !== undefined && first.indent !== 0) {
      throw new YamlAbort("document must start at the left margin", first.line);
    }
    const { node, next } = parseMapping(lines, 0, 0, 1);
    if (next < lines.length) {
      const stray = lines[next];
      throw new YamlAbort(
        "unexpected indentation or trailing content",
        stray === undefined ? 0 : stray.line,
      );
    }
    return { ok: true, node };
  } catch (err) {
    if (err instanceof YamlAbort) {
      return { ok: false, error: { message: err.detail, line: err.lineNo } };
    }
    throw err;
  }
}

/**
 * Split the source into significant {@link PhysicalLine}s.
 *
 * Comments and blank lines are dropped; tab-indented lines are rejected so
 * indentation is unambiguous (a common YAML footgun the spec forbids).
 */
function tokenizeLines(text: string): PhysicalLine[] {
  const rawLines = text.split(/\r\n|\r|\n/u);
  const result: PhysicalLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const lineNo = i + 1;

    // Measure the indent and reject tabs within it.
    let indent = 0;
    while (indent < raw.length) {
      const ch = raw.charCodeAt(indent);
      if (ch === 0x20) {
        indent += 1;
      } else if (ch === 0x09) {
        throw new YamlAbort(
          "tab characters are not allowed in indentation",
          lineNo,
        );
      } else {
        break;
      }
    }

    const withoutComment = stripComment(raw.slice(indent));
    const text2 = withoutComment.replace(/\s+$/u, "");
    if (text2.length === 0) {
      continue; // blank or comment-only line
    }
    result.push({ indent, text: text2, line: lineNo });
  }
  return result;
}

/**
 * Remove a trailing `#` comment from a line body, respecting quoted strings.
 *
 * A `#` opens a comment only at the start of the body or when preceded by
 * whitespace; a `#` inside a quoted scalar (or immediately following a
 * non-space character) is preserved as literal text.
 */
function stripComment(body: string): string {
  let quote = 0; // 0 = none, otherwise the open-quote char code
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charCodeAt(i);
    if (quote !== 0) {
      if (ch === quote) {
        quote = 0;
      }
      continue;
    }
    if (ch === 0x22 || ch === 0x27) {
      quote = ch; // enter a double- or single-quoted span
      continue;
    }
    if (ch === 0x23) {
      const prev = i === 0 ? 0x20 : body.charCodeAt(i - 1);
      if (prev === 0x20 || prev === 0x09) {
        return body.slice(0, i);
      }
    }
  }
  return body;
}

/**
 * Parse a block mapping whose entries all sit at column `indent`.
 *
 * @param lines - All significant lines.
 * @param start - Index of the first line to consider.
 * @param indent - The exact column shared by this mapping's keys.
 * @param depth - Current nesting depth, guarded by {@link YAML_MAX_DEPTH}.
 * @returns The mapping node and the index of the first line not consumed.
 */
function parseMapping(
  lines: readonly PhysicalLine[],
  start: number,
  indent: number,
  depth: number,
): { node: YamlNode; next: number } {
  if (depth > YAML_MAX_DEPTH) {
    const at = lines[start];
    throw new YamlAbort(
      `maximum nesting depth ${YAML_MAX_DEPTH} exceeded`,
      at === undefined ? 0 : at.line,
    );
  }

  const entries = new Map<string, YamlNode>();
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break; // belongs to an enclosing mapping
    }
    if (line.indent > indent) {
      throw new YamlAbort("unexpected indentation", line.line);
    }

    const { key, rest } = splitKey(line);
    if (entries.has(key)) {
      throw new YamlAbort(`duplicate key '${key}'`, line.line);
    }

    if (rest.length > 0) {
      // Inline scalar (or empty flow collection) on the same line.
      entries.set(key, parseScalar(rest, line.line));
      index += 1;
      continue;
    }

    // No inline value: either a nested block mapping or an explicit null.
    const child = lines[index + 1];
    if (child !== undefined && child.indent > indent) {
      const nested = parseMapping(lines, index + 1, child.indent, depth + 1);
      entries.set(key, nested.node);
      index = nested.next;
    } else {
      entries.set(key, { kind: "null" });
      index += 1;
    }
  }

  return { node: { kind: "map", entries }, next: index };
}

/**
 * Split a `key: value` line into its key and the (possibly empty) remainder.
 *
 * The key is a plain identifier or a quoted string; the first `: ` (or a
 * trailing `:`) separates it from the value.
 */
function splitKey(line: PhysicalLine): { key: string; rest: string } {
  const body = line.text;
  if (body.charCodeAt(0) === 0x22 || body.charCodeAt(0) === 0x27) {
    // Quoted key: find the matching close quote, then the following colon.
    const quote = body.charCodeAt(0);
    let i = 1;
    while (i < body.length && body.charCodeAt(i) !== quote) {
      i += 1;
    }
    if (i >= body.length) {
      throw new YamlAbort("unterminated quoted key", line.line);
    }
    const key = body.slice(1, i);
    const after = body.slice(i + 1).replace(/^\s*/u, "");
    if (after.charCodeAt(0) !== 0x3a) {
      throw new YamlAbort("expected ':' after key", line.line);
    }
    return { key, rest: after.slice(1).replace(/^\s+/u, "") };
  }

  const colon = findKeyColon(body, line.line);
  const key = body.slice(0, colon).replace(/\s+$/u, "");
  if (key.length === 0) {
    throw new YamlAbort("missing mapping key", line.line);
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
    throw new YamlAbort(`invalid mapping key '${key}'`, line.line);
  }
  return { key, rest: body.slice(colon + 1).replace(/^\s+/u, "") };
}

/** Find the index of the key/value separator colon in a plain-key line. */
function findKeyColon(body: string, lineNo: number): number {
  for (let i = 0; i < body.length; i += 1) {
    if (body.charCodeAt(i) === 0x3a) {
      // A colon terminates the key when it ends the line or is followed by
      // whitespace; `a:b` (no space) is not a valid mapping separator here.
      const nextCh = i + 1 < body.length ? body.charCodeAt(i + 1) : 0x20;
      if (nextCh === 0x20 || nextCh === 0x09) {
        return i;
      }
      if (i + 1 >= body.length) {
        return i;
      }
    }
  }
  throw new YamlAbort("expected 'key: value' mapping entry", lineNo);
}

/**
 * Parse an inline scalar value into a {@link YamlNode}.
 *
 * Recognizes quoted strings, `null`/`~`, `true`/`false`, decimal integers, the
 * empty flow collections `{}`/`[]`, and otherwise a plain string. Non-empty
 * flow collections and block/anchor sigils are rejected.
 */
function parseScalar(value: string, lineNo: number): YamlNode {
  const first = value.charCodeAt(0);

  if (first === 0x22) {
    return { kind: "string", value: parseDoubleQuoted(value, lineNo) };
  }
  if (first === 0x27) {
    return { kind: "string", value: parseSingleQuoted(value, lineNo) };
  }

  if (value === "{}") {
    return { kind: "map", entries: new Map() };
  }
  if (value === "[]") {
    return { kind: "list", items: [] };
  }
  if (first === 0x5b) {
    // '['
    return parseFlowList(value, lineNo);
  }
  if (value === "null" || value === "~") {
    return { kind: "null" };
  }
  if (value === "true") {
    return { kind: "bool", value: true };
  }
  if (value === "false") {
    return { kind: "bool", value: false };
  }
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    return { kind: "int", raw: value };
  }

  // Reject constructs this subset intentionally does not support.
  if (
    first === 0x7b || // '{'
    first === 0x5b || // '['
    first === 0x26 || // '&' anchor
    first === 0x2a || // '*' alias
    first === 0x7c || // '|' block scalar
    first === 0x3e || // '>' folded scalar
    first === 0x21 // '!' tag
  ) {
    throw new YamlAbort(`unsupported YAML value '${value}'`, lineNo);
  }

  return { kind: "string", value };
}

/** Parse a double-quoted scalar, decoding a small set of C-style escapes. */
/** Parse the deliberately small signature flow-list form, e.g. `[int, list[int]]`.
 * Elements use the same scalar grammar and nested brackets are retained inside
 * type strings rather than interpreted as a second YAML collection. */
function parseFlowList(value: string, lineNo: number): YamlNode {
  if (!value.endsWith("]"))
    throw new YamlAbort("unterminated flow list", lineNo);
  const body = value.slice(1, -1).trim();
  if (body === "") return { kind: "list", items: [] };
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code === 0x5b) depth += 1;
    else if (code === 0x5d) {
      depth -= 1;
      if (depth < 0) throw new YamlAbort("invalid flow list", lineNo);
    } else if (code === 0x2c && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) throw new YamlAbort("unterminated nested type", lineNo);
  parts.push(body.slice(start).trim());
  if (parts.some((part) => part.length === 0))
    throw new YamlAbort("empty flow-list item", lineNo);
  return {
    kind: "list",
    items: parts.map((part) => parseScalar(part, lineNo)),
  };
}

function parseDoubleQuoted(value: string, lineNo: number): string {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= value.length) {
      throw new YamlAbort("unterminated double-quoted string", lineNo);
    }
    const ch = value.charCodeAt(i);
    if (ch === 0x22) {
      if (i !== value.length - 1) {
        throw new YamlAbort("trailing content after quoted string", lineNo);
      }
      return out;
    }
    if (ch === 0x5c) {
      const esc = value.charCodeAt(i + 1);
      switch (esc) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += "\\";
          break;
        case 0x6e:
          out += "\n";
          break;
        case 0x74:
          out += "\t";
          break;
        case 0x30:
          out += "\0";
          break;
        default:
          throw new YamlAbort("invalid escape in double-quoted string", lineNo);
      }
      i += 2;
      continue;
    }
    out += value[i];
    i += 1;
  }
}

/**
 * Parse a single-quoted scalar. Only the doubled-quote escape (`''` → `'`) is
 * recognized, exactly as YAML specifies for single-quoted flow scalars.
 */
function parseSingleQuoted(value: string, lineNo: number): string {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= value.length) {
      throw new YamlAbort("unterminated single-quoted string", lineNo);
    }
    const ch = value.charCodeAt(i);
    if (ch === 0x27) {
      if (value.charCodeAt(i + 1) === 0x27) {
        out += "'";
        i += 2;
        continue;
      }
      if (i !== value.length - 1) {
        throw new YamlAbort("trailing content after quoted string", lineNo);
      }
      return out;
    }
    out += value[i];
    i += 1;
  }
}
