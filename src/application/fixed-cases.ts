/**
 * Strict, bounded fixed-case loading for the `test` command.
 *
 * Case assets are static JSON documents, not runtime protocol envelopes. Every
 * file must contain exactly `{ "input": CanonicalValue, "expected":
 * CanonicalValue }`; request/response envelope identities are added only by the
 * test facade immediately before launching the target.
 */

import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildValue } from "../judging/codec/decode.js";
import { CanonicalValidationError } from "../judging/codec/errors.js";
import { parseJson, type JsonNode } from "../judging/codec/json.js";
import { Budget, MAX_PAYLOAD_BYTES } from "../judging/codec/limits.js";
import { decodeUtf8Fatal } from "../judging/codec/utf8.js";
import type { CanonicalValue } from "../judging/value/index.js";

/** A fixed case after its static JSON document has been validated. */
export interface FixedCase {
  /** Absolute real path to the selected case file. */
  readonly path: string;
  /** Stable path for result/artifact display, relative to the problem root. */
  readonly relativePath: string;
  /** Canonical value supplied to the target inside a request envelope. */
  readonly input: CanonicalValue;
  /** Canonical expected target result. */
  readonly expected: CanonicalValue;
}

/** Input roots and optional `--case` selection used by the source. */
export interface FixedCaseSelection {
  /** Absolute problem root used to confine all case assets. */
  readonly problemRoot: string;
  /** Absolute configured cases directory inside `problemRoot`. */
  readonly casesDir: string;
  /** Invocation directory, used for the invocation-first CLI override lookup. */
  readonly invocationDirectory: string;
  /** Raw `--case` text, when only one file should be selected. */
  readonly caseOverride?: string;
  /** Maximum permitted raw case-document bytes. Defaults to codec payload cap. */
  readonly maxBytes?: number;
}

/** A configuration/data failure discovered before target execution. */
export class FixedCaseError extends Error {
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Stream selected fixed cases in deterministic lexical path order.
 *
 * The iterator never materializes case contents for an entire directory: it
 * reads, validates, and yields exactly one file at a time. Directory entries
 * that are symlinks, non-regular files, or non-`.json` names are invalid case
 * data rather than target failures, preventing an accidental host-file read.
 */
export async function* streamFixedCases(
  selection: FixedCaseSelection,
): AsyncGenerator<FixedCase> {
  const roots = await resolveRoots(selection);
  const maxBytes = selection.maxBytes ?? MAX_PAYLOAD_BYTES;
  assertBound(maxBytes, "maximum case byte size");

  if (selection.caseOverride !== undefined) {
    const path = await resolveCaseOverride(selection, roots.problemRoot);
    yield await readFixedCase(path, roots.problemRoot, maxBytes);
    return;
  }

  const directory = await requireRealDirectory(selection.casesDir, roots.problemRoot, "cases directory");
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw fileFailure("cannot list cases directory", directory, error);
  }
  for (const entry of [...entries].sort(compareLexical)) {
    const candidate = resolve(directory, entry);
    if (extname(entry) !== ".json") {
      throw new FixedCaseError(`case directory contains non-.json entry: ${entry}`);
    }
    yield await readFixedCase(candidate, roots.problemRoot, maxBytes);
  }
}

/** Parse one bounded static case document at a known confined regular file. */
export async function readFixedCase(
  path: string,
  problemRoot: string,
  maxBytes = MAX_PAYLOAD_BYTES,
): Promise<FixedCase> {
  assertBound(maxBytes, "maximum case byte size");
  const roots = await resolveRoots({ problemRoot });
  const actualPath = await requireRealRegularFile(path, roots.problemRoot, "case file");
  let bytes: Uint8Array;
  try {
    const info = await stat(actualPath);
    if (info.size > maxBytes) {
      throw new FixedCaseError(`case file exceeds ${maxBytes} bytes: ${displayPath(actualPath)}`);
    }
    bytes = await readFile(actualPath);
  } catch (error) {
    if (error instanceof FixedCaseError) throw error;
    throw fileFailure("cannot read case file", actualPath, error);
  }
  if (bytes.length > maxBytes) {
    throw new FixedCaseError(`case file exceeds ${maxBytes} bytes: ${displayPath(actualPath)}`);
  }
  const decoded = decodeFixedCaseDocument(bytes, displayPath(actualPath));
  return Object.freeze({
    path: actualPath,
    relativePath: toProblemRelative(roots.problemRoot, actualPath),
    ...decoded,
  });
}

/**
 * Decode strict static case bytes without using lossy `JSON.parse`.
 *
 * `parseJson` rejects duplicate object keys and preserves numeric lexemes;
 * `buildValue` subsequently validates each tagged value and constructs bigint
 * integers exactly as the runtime codec does.
 */
export function decodeFixedCaseDocument(
  bytes: Uint8Array,
  source = "case file",
): Readonly<{ input: CanonicalValue; expected: CanonicalValue }> {
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new FixedCaseError(`${source} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  let text: string;
  try {
    text = decodeUtf8Fatal(bytes);
  } catch (error) {
    throw new FixedCaseError(`${source} is not valid UTF-8: ${messageOf(error)}`);
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new FixedCaseError(`${source} contains invalid JSON: ${parsed.error.message}`);
  }
  const fields = requireCaseObject(parsed.node, source);
  try {
    return Object.freeze({
      input: buildValue(fields.input, new Budget()),
      expected: buildValue(fields.expected, new Budget()),
    });
  } catch (error) {
    const detail = error instanceof CanonicalValidationError ? error.message : messageOf(error);
    throw new FixedCaseError(`${source} contains an invalid canonical value: ${detail}`);
  }
}

async function resolveCaseOverride(
  selection: FixedCaseSelection,
  problemRoot: string,
): Promise<string> {
  const override = selection.caseOverride!;
  if (override.includes("\0")) {
    throw new FixedCaseError("case path contains a NUL byte");
  }
  // The first candidate follows ordinary CLI path resolution. It only wins when
  // it exists and can be proven to remain under the problem root.
  const invocationCandidate = isAbsolute(override)
    ? resolve(override)
    : resolve(selection.invocationDirectory, override);
  if (await exists(invocationCandidate)) {
    return requireRealRegularFile(invocationCandidate, problemRoot, "selected case file");
  }
  if (isAbsolute(override)) {
    throw new FixedCaseError(`selected case file does not exist: ${displayPath(invocationCandidate)}`);
  }
  const fallback = resolve(selection.casesDir, override);
  return requireRealRegularFile(fallback, problemRoot, "selected case file");
}

async function resolveRoots(selection: Pick<FixedCaseSelection, "problemRoot">): Promise<{ problemRoot: string }> {
  const problemRoot = await requireRealDirectory(selection.problemRoot, undefined, "problem root");
  return { problemRoot };
}

async function requireRealDirectory(
  path: string,
  problemRoot: string | undefined,
  label: string,
): Promise<string> {
  const actual = await requireNotSymlink(path, label);
  let resolved: string;
  try {
    resolved = await realpath(actual);
  } catch (error) {
    throw fileFailure(`${label} does not exist`, actual, error);
  }
  if (problemRoot !== undefined) assertInside(problemRoot, resolved, label);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw fileFailure(`cannot stat ${label}`, resolved, error);
  }
  if (!info.isDirectory()) throw new FixedCaseError(`${label} is not a directory: ${displayPath(path)}`);
  return resolved;
}

async function requireRealRegularFile(
  path: string,
  problemRoot: string,
  label: string,
): Promise<string> {
  if (path.includes("\0")) {
    throw new FixedCaseError(`${label} path contains a NUL byte`);
  }
  if (extname(path) !== ".json") {
    throw new FixedCaseError(`${label} must have a .json extension: ${displayPath(path)}`);
  }
  const actual = await requireNotSymlink(path, label);
  let resolved: string;
  try {
    resolved = await realpath(actual);
  } catch (error) {
    throw fileFailure(`${label} does not exist`, actual, error);
  }
  assertInside(problemRoot, resolved, label);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw fileFailure(`cannot stat ${label}`, resolved, error);
  }
  if (!info.isFile()) throw new FixedCaseError(`${label} is not a regular file: ${displayPath(path)}`);
  return resolved;
}

async function requireNotSymlink(path: string, label: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw fileFailure(`${label} does not exist`, path, error);
  }
  if (info.isSymbolicLink()) {
    throw new FixedCaseError(`${label} must not be a symbolic link: ${displayPath(path)}`);
  }
  return path;
}

function requireCaseObject(node: JsonNode, source: string): { input: JsonNode; expected: JsonNode } {
  if (node.kind !== "object") throw new FixedCaseError(`${source} root must be an object`);
  const keys = [...node.members.keys()];
  if (keys.length !== 2 || !node.members.has("input") || !node.members.has("expected")) {
    throw new FixedCaseError(`${source} must contain exactly the keys "input" and "expected"`);
  }
  return { input: node.members.get("input")!, expected: node.members.get("expected")! };
}

function assertInside(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FixedCaseError(`${label} escapes the problem root: ${displayPath(candidate)}`);
  }
}

function toProblemRelative(root: string, path: string): string {
  const value = relative(root, path);
  assertInside(root, path, "case file");
  return value === "" ? "." : value.split(sep).join("/");
}

function assertBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PAYLOAD_BYTES) {
    throw new FixedCaseError(`${label} must be a positive safe integer no greater than ${MAX_PAYLOAD_BYTES}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function compareLexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function displayPath(path: string): string {
  return path.length <= 512 ? path : `${path.slice(0, 509)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileFailure(action: string, path: string, error: unknown): FixedCaseError {
  return new FixedCaseError(`${action}: ${displayPath(path)} (${messageOf(error)})`);
}
