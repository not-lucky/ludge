/**
 * Immutable, content-addressed differential-fuzzing artifacts.
 *
 * The artifact is intentionally self-contained: replay must not depend on a
 * mutable database row or current problem configuration to recover the exact
 * request bytes and policy that formed a finding. The SHA-256 of the canonical
 * document is both its identity and the directory name used for storage.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ResourceLimits } from "../domain/index.js";

/** Current on-disk fuzz artifact schema. */
export const FUZZ_ARTIFACT_SCHEMA_VERSION = 1 as const;

/** Bounded facts retained for one isolated target execution. */
export interface FuzzExecutionEnvelope {
  readonly status: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutBase64Url: string;
  readonly stderrBase64Url: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly wallTimeMs: number;
  readonly cpuTimeMs: number;
  readonly memoryPeakBytes: number;
  readonly termination: string;
  readonly exception: unknown | null;
  readonly output: unknown | null;
}

/** Exact fact a shrink candidate or replay must preserve. */
export interface FailurePredicate {
  readonly kind: "oracle_failure" | "optimized_failure" | "mismatch";
  readonly naiveStatus: string;
  readonly solutionStatus: string;
  readonly mismatchPath: string | null;
  readonly mismatchReason: string | null;
}

/** Deterministic shrink result saved with the best valid input. */
export interface ShrinkResult {
  readonly requested: boolean;
  readonly steps: number;
  readonly reason: "not_requested" | "complete" | "step_cap" | "time_cap";
  readonly originalBytes: number;
  readonly minimizedBytes: number;
}

/** Full replayable mismatch document, encoded as strict JSON. */
export interface FuzzArtifactDocument {
  readonly schemaVersion: typeof FUZZ_ARTIFACT_SCHEMA_VERSION;
  readonly kind: "fuzz-finding";
  readonly sourceRunId: string;
  readonly sourceCaseId: string;
  readonly slug: string;
  readonly seed: string;
  readonly caseIndex: number;
  readonly inputCodecVersion: string;
  readonly outputCodecVersion: string;
  readonly comparatorVersion: string;
  readonly runtime: string;
  readonly limits: ResourceLimits;
  readonly generatorPath: string;
  readonly naivePath: string;
  readonly solutionPath: string;
  readonly originalInputBase64Url: string;
  readonly minimizedInputBase64Url: string;
  readonly predicate: FailurePredicate;
  readonly naive: FuzzExecutionEnvelope;
  readonly solution: FuzzExecutionEnvelope;
  readonly shrink: ShrinkResult;
  readonly createdAt: string;
}

/** Metadata returned only after an atomic artifact write completes. */
export interface StoredFuzzArtifact {
  readonly artifactId: string;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: bigint;
}

/** Error raised for malformed, unavailable, or tampered artifacts. */
export class FuzzArtifactError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FuzzArtifactError";
  }
}

/** Serialize a document exactly once, with no formatting-dependent identity. */
export function serializeFuzzArtifact(document: FuzzArtifactDocument): Uint8Array {
  assertFuzzArtifactDocument(document);
  return new TextEncoder().encode(JSON.stringify(document));
}

/** Content identifier for an already-validated document. */
export function fuzzArtifactId(document: FuzzArtifactDocument): string {
  return sha256(serializeFuzzArtifact(document));
}

/**
 * Atomically write a new immutable artifact directory below the invocation
 * root. A cap check happens before final rename and never removes old files.
 */
export async function writeFuzzArtifact(
  invocationDirectory: string,
  document: FuzzArtifactDocument,
  storageCapBytes: number | undefined,
): Promise<StoredFuzzArtifact> {
  const bytes = serializeFuzzArtifact(document);
  const artifactId = sha256(bytes);
  const artifactsRoot = resolve(invocationDirectory, ".palestra", "artifacts");
  const destination = resolve(artifactsRoot, artifactId);
  const temporary = resolve(artifactsRoot, `.${artifactId}.${randomUUID()}.tmp`);
  await mkdir(artifactsRoot, { recursive: true });
  if (storageCapBytes !== undefined && (await directoryBytes(artifactsRoot)) + bytes.length > storageCapBytes) {
    throw new FuzzArtifactError("artifact storage cap would be exceeded");
  }
  try {
    await mkdir(temporary, { recursive: false });
    await writeFile(resolve(temporary, "artifact.json"), bytes, { flag: "wx" });
    try {
      await rename(temporary, destination);
    } catch (error: unknown) {
      // Identical content is already durable, so idempotent retries are safe.
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    artifactId,
    path: `.palestra/artifacts/${artifactId}/artifact.json`,
    sha256: artifactId,
    sizeBytes: BigInt(bytes.length),
  });
}

/** Load, hash-verify, and strictly validate one content-addressed artifact. */
export async function loadFuzzArtifact(path: string, expectedId: string): Promise<FuzzArtifactDocument> {
  if (!/^[a-f0-9]{64}$/u.test(expectedId) || basename(resolve(path, "..")) !== expectedId) {
    throw new FuzzArtifactError("invalid artifact content identifier");
  }
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedId) throw new FuzzArtifactError("artifact SHA-256 does not match its identifier");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new FuzzArtifactError("artifact is not valid JSON"); }
  assertFuzzArtifactDocument(value);
  return Object.freeze(value);
}

/** Strictly validate untrusted artifact JSON before it reaches replay. */
export function assertFuzzArtifactDocument(value: unknown): asserts value is FuzzArtifactDocument {
  if (!isRecord(value) || value.schemaVersion !== FUZZ_ARTIFACT_SCHEMA_VERSION || value.kind !== "fuzz-finding") {
    throw new FuzzArtifactError("unsupported fuzz artifact schema");
  }
  for (const key of ["sourceRunId", "sourceCaseId", "slug", "seed", "inputCodecVersion", "outputCodecVersion", "comparatorVersion", "runtime", "generatorPath", "naivePath", "solutionPath", "originalInputBase64Url", "minimizedInputBase64Url", "createdAt"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) throw new FuzzArtifactError(`artifact field ${key} must be a non-empty string`);
  }
  const seed = value.seed;
  const caseIndex = value.caseIndex;
  if (typeof seed !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(seed) || typeof caseIndex !== "number" || !Number.isSafeInteger(caseIndex) || caseIndex < 0) throw new FuzzArtifactError("artifact seed or case index is invalid");
  assertBytes(value.originalInputBase64Url, "originalInputBase64Url");
  assertBytes(value.minimizedInputBase64Url, "minimizedInputBase64Url");
  if (!isRecord(value.limits) || !isRecord(value.predicate) || !isRecord(value.naive) || !isRecord(value.solution) || !isRecord(value.shrink)) throw new FuzzArtifactError("artifact nested object is invalid");
  assertLimits(value.limits);
  if (!["oracle_failure", "optimized_failure", "mismatch"].includes(String(value.predicate.kind)) || typeof value.predicate.naiveStatus !== "string" || typeof value.predicate.solutionStatus !== "string" || !(typeof value.predicate.mismatchPath === "string" || value.predicate.mismatchPath === null) || !(typeof value.predicate.mismatchReason === "string" || value.predicate.mismatchReason === null)) throw new FuzzArtifactError("artifact predicate is invalid");
  const shrink = value.shrink;
  const steps = shrink.steps; const originalBytes = shrink.originalBytes; const minimizedBytes = shrink.minimizedBytes;
  if (typeof shrink.requested !== "boolean" || typeof steps !== "number" || !Number.isSafeInteger(steps) || steps < 0 || !["not_requested", "complete", "step_cap", "time_cap"].includes(String(shrink.reason)) || typeof originalBytes !== "number" || !Number.isSafeInteger(originalBytes) || typeof minimizedBytes !== "number" || !Number.isSafeInteger(minimizedBytes) || originalBytes < 0 || minimizedBytes < 0) throw new FuzzArtifactError("artifact shrink result is invalid");
  for (const envelope of [value.naive, value.solution]) assertEnvelope(envelope);
}

function assertLimits(value: Record<string, unknown>): void {
  for (const key of ["wallTimeMs", "cpuTimeMs", "memoryBytes", "stdoutBytes", "stderrBytes", "combinedOutputBytes", "inputBytes", "fileSizeBytes", "processCount", "openDescriptors", "tempStorageBytes", "concurrencyPerCase"] as const) {
    const limit = value[key];
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) throw new FuzzArtifactError(`artifact limit ${key} is invalid`);
  }
}

function assertEnvelope(value: Record<string, unknown>): void {
  for (const key of ["status", "stdoutBase64Url", "stderrBase64Url", "termination"] as const) if (typeof value[key] !== "string") throw new FuzzArtifactError(`artifact envelope ${key} is invalid`);
  for (const key of ["stdoutBytes", "stderrBytes", "wallTimeMs", "cpuTimeMs", "memoryPeakBytes"] as const) if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) throw new FuzzArtifactError(`artifact envelope ${key} is invalid`);
  if (typeof value.stdoutTruncated !== "boolean" || typeof value.stderrTruncated !== "boolean") throw new FuzzArtifactError("artifact envelope truncation flag is invalid");
  assertBytes(value.stdoutBase64Url, "stdoutBase64Url"); assertBytes(value.stderrBase64Url, "stderrBase64Url");
}
function assertBytes(value: unknown, field: string): void { if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) throw new FuzzArtifactError(`artifact field ${field} is not base64url`); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += Number((await stat(path)).size);
  }
  return total;
}
