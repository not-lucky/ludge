/** Replay a stored fuzz finding without mutating its source run or artifact. */

import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { initialGeneration, toCaseId, toRunId, type ExecutionStatus, type RawProcessResult, type ResourceLimits, type RunId, type TerminationCause } from "../domain/index.js";
import type { CancellationToken, Clock, RuntimeBundle } from "../execution/ports/index.js";
import { assertConfigurationValid, loadProblemConfig, parseEnvOverrides, resolveEffectiveConfig, type ConfigProbes, type EffectiveConfig, type EnvironmentRecord } from "../infrastructure/config/index.js";
import { decodeRequestLine, encodeRequestLine, isSupportedCodecVersion } from "../judging/codec/index.js";
import { createOutputComparator, EXACT_V1_VERSION } from "../judging/comparator/index.js";
import type { PersistenceRecords, TransactionScope } from "../persistence/ports/index.js";
import { loadFuzzArtifact, type FailurePredicate, type FuzzArtifactDocument } from "./fuzz-artifact.js";
import { executeEncodedIsolated, sha256Bytes, type IsolatedExecution } from "./isolated-execution.js";

export interface ReplayInvocation { readonly artifactId: string; readonly unsafeLocal: boolean; }
/** Persistence shapes required to commit a standalone replay run and link. */
export interface ReplayPersistenceRecords extends PersistenceRecords {
  readonly implementation: { readonly implementation_id: string; readonly problem_id: string; readonly path: string; readonly role: string; readonly content_sha256: string; readonly runtime: string; readonly created_at: string };
  readonly case: { readonly case_id: string; readonly run_id: string; readonly ordinal: number; readonly input_sha256: string; readonly input_bytes: bigint; readonly status: string };
  readonly execution: { readonly execution_id: string; readonly case_id: string; readonly implementation_id: string; readonly status: string; readonly exit_code: number | null; readonly signal: string | null; readonly wall_ns: bigint | null; readonly cpu_ns: bigint | null; readonly peak_memory_bytes: bigint | null; readonly stdout_bytes: bigint | null; readonly stderr_bytes: bigint | null; readonly stdout_truncated: 0 | 1 | null; readonly stderr_truncated: 0 | 1 | null; readonly limit_cause: string | null; readonly raw_json: string | null };
  readonly replay: { readonly replay_run_id: string; readonly source_artifact_id: string; readonly created_at: string };
}
export interface ArtifactLookup { findById(id: string): Promise<{ readonly artifact_id: string; readonly path: string; readonly sha256: string } | null>; }
export interface ReplayOutcome { readonly status: ExecutionStatus; readonly result: { readonly runId: string; readonly artifactId: string; readonly reproduced: boolean; readonly predicate: FailurePredicate | null } | null; readonly diagnostics: readonly { readonly code: string; readonly message: string }[]; }
export interface ReplayDependencies {
  readonly invocationDirectory: string; readonly environment: EnvironmentRecord; readonly cancellation: CancellationToken; readonly clock: Clock; readonly probes: ConfigProbes; readonly supportedRuntimes: ReadonlySet<string>; readonly requiredControls: readonly ("cgroup" | "rlimits" | "network" | "filesystem" | "no-new-privileges" | "drop-capabilities" | "namespaces" | "seccomp")[]; readonly createBundle: (effective: EffectiveConfig) => RuntimeBundle; readonly classifyTermination: (raw: RawProcessResult, limits: ResourceLimits) => TerminationCause; readonly artifacts: ArtifactLookup; readonly transaction: TransactionScope<ReplayPersistenceRecords>; readonly createId?: () => string;
}

/** Verify and replay a content-addressed artifact using its recorded limits/policy. */
export async function executeReplayCommand(command: ReplayInvocation, d: ReplayDependencies): Promise<ReplayOutcome> {
  try {
    const metadata = await d.artifacts.findById(command.artifactId);
    if (metadata === null || metadata.sha256 !== command.artifactId) return failure("invalid_input", "artifact_not_found", "artifact is unavailable");
    const artifactPath = resolve(d.invocationDirectory, metadata.path);
    if (!isDescendant(d.invocationDirectory, artifactPath)) return failure("invalid_input", "artifact_path", "artifact path escapes the invocation root");
    const artifact = await loadFuzzArtifact(artifactPath, command.artifactId);
    if (!isSupportedCodecVersion(artifact.inputCodecVersion) || !isSupportedCodecVersion(artifact.outputCodecVersion) || artifact.comparatorVersion !== EXACT_V1_VERSION) return failure("invalid_input", "unsupported_recorded_version", "artifact records unsupported codec or comparator versions");
    const prepared = await prepare(artifact, command, d);
    const runId = toRunId(identifier(d)); const caseId = toCaseId(identifier(d));
    const recordedRequest = Buffer.from(artifact.minimizedInputBase64Url, "base64url");
    if (recordedRequest.length > artifact.limits.inputBytes) return failure("invalid_input", "artifact_input_limit", "recorded input exceeds its recorded limit");
    const decodedRequest = decodeRequestLine(recordedRequest);
    if (!decodedRequest.ok || decodedRequest.envelope.codecVersion !== artifact.inputCodecVersion) return failure("invalid_input", "artifact_protocol", "artifact input request is invalid");
    const inputBytes = encodeRequestLine({ protocolVersion: 1, kind: "request", runId, caseId, codecVersion: artifact.inputCodecVersion, messageLimitBytes: artifact.limits.inputBytes, input: decodedRequest.envelope.input });
    const base = { runId, caseId, problemFingerprint: prepared.effective.problem.slug, inputCodecVersion: artifact.inputCodecVersion, outputCodecVersion: artifact.outputCodecVersion, limits: artifact.limits, generation: initialGeneration() };
    const naive = await executeEncodedIsolated(prepared.effective, { ...base, inputBytes, implementation: { role: "naive", relativePath: prepared.naive } }, { bundle: prepared.bundle, cancellation: d.cancellation, classifyTermination: d.classifyTermination });
    const solution = await executeEncodedIsolated(prepared.effective, { ...base, inputBytes, implementation: { role: "solution", relativePath: prepared.solution } }, { bundle: prepared.bundle, cancellation: d.cancellation, classifyTermination: d.classifyTermination });
    const predicate = predicateOf(artifact, naive, solution);
    const reproduced = predicate !== null && samePredicate(predicate, artifact.predicate);
    await persistReplay(prepared.effective, artifact, command.artifactId, runId, String(caseId), inputBytes, naive, solution, d);
    const status: ExecutionStatus = reproduced ? "passed" : "wrong_answer";
    return { status, result: { runId, artifactId: command.artifactId, reproduced, predicate }, diagnostics: [] };
  } catch (error) { return failure("invalid_input", "replay_failed", error instanceof Error ? error.message : String(error)); }
}

async function prepare(artifact: FuzzArtifactDocument, command: ReplayInvocation, d: ReplayDependencies): Promise<{ effective: EffectiveConfig; bundle: RuntimeBundle; naive: string; solution: string }> {
  const root = await realpath(`${d.invocationDirectory}/problems/${artifact.slug}`);
  const problem = loadProblemConfig(await readFile(`${root}/problem.yaml`, "utf8"));
  if (problem.runtime !== artifact.runtime || problem.inputCodec !== artifact.inputCodecVersion || problem.outputCodec !== artifact.outputCodecVersion || problem.comparisonPolicy !== artifact.comparatorVersion) throw new Error("current problem does not support artifact runtime or versions");
  const effective = resolveEffectiveConfig({ problem, env: parseEnvOverrides(d.environment), cli: { unsafeLocal: command.unsafeLocal }, context: { invocationDir: d.invocationDirectory, problemRoot: root } });
  await assertConfigurationValid({ effective, probes: d.probes, supportedRuntimes: d.supportedRuntimes, requiredControls: d.requiredControls });
  const recordedEffective = Object.freeze({ ...effective, limits: artifact.limits });
  return { effective: recordedEffective, bundle: d.createBundle(recordedEffective), naive: confined(root, await realpath(`${root}/${artifact.naivePath}`)), solution: confined(root, await realpath(`${root}/${artifact.solutionPath}`)) };
}
function predicateOf(artifact: FuzzArtifactDocument, naive: IsolatedExecution, solution: IsolatedExecution): FailurePredicate | null {
  if (naive.status !== "passed" || naive.exception !== null || naive.output === null) return { kind: "oracle_failure", naiveStatus: naive.status, solutionStatus: solution.status, mismatchPath: null, mismatchReason: null };
  if (solution.status !== "passed" || solution.exception !== null || solution.output === null) return { kind: "optimized_failure", naiveStatus: naive.status, solutionStatus: solution.status, mismatchPath: null, mismatchReason: null };
  const result = createOutputComparator().compare(naive.output, solution.output, { version: artifact.comparatorVersion, equality: "semantic", normalizeWhitespace: false });
  return result.equal ? null : { kind: "mismatch", naiveStatus: naive.status, solutionStatus: solution.status, mismatchPath: result.mismatch.path, mismatchReason: result.mismatch.reason };
}
async function persistReplay(effective: EffectiveConfig, artifact: FuzzArtifactDocument, artifactId: string, runId: RunId, caseId: string, input: Uint8Array, naive: IsolatedExecution, solution: IsolatedExecution, d: ReplayDependencies): Promise<void> {
  const now = d.clock.wallTimeUtc();
  await d.transaction.transact(async uow => {
    await uow.runs.commit({ runId, slug: artifact.slug, state: "completed", status: solution.status, problemFingerprint: effective.problem.slug, seed: artifact.seed, limits: artifact.limits, inputCodecVersion: artifact.inputCodecVersion, outputCodecVersion: artifact.outputCodecVersion, comparisonPolicyVersion: artifact.comparatorVersion, inputHash: sha256Bytes(input), outputHash: null, generation: initialGeneration(), wallTimeUtc: now, durationMs: 0 });
    await uow.cases.commit({ case_id: caseId, run_id: String(runId), ordinal: artifact.caseIndex, input_sha256: sha256Bytes(input), input_bytes: BigInt(input.length), status: solution.status });
    const problemId = `problem-${artifact.slug}`;
    for (const [role, path, execution] of [["naive", artifact.naivePath, naive], ["solution", artifact.solutionPath, solution]] as const) {
      const source = await readFile(`${effective.problemRoot}/${path}`, "utf8");
      const implementationId = `implementation-${sha256Bytes(new TextEncoder().encode(source))}`;
      await uow.implementations.register({ implementation_id: implementationId, problem_id: problemId, path, role, content_sha256: sha256Bytes(new TextEncoder().encode(source)), runtime: artifact.runtime, created_at: now });
      await uow.executions.commit(executionRow(identifier(d), caseId, implementationId, execution));
    }
    await uow.replays.commit({ replay_run_id: String(runId), source_artifact_id: artifactId, created_at: now });
  });
}
function executionRow(executionId: string, caseId: string, implementationId: string, execution: IsolatedExecution) {
  const envelope = execution.envelope;
  const stdoutTruncated: 0 | 1 = envelope.stdoutTruncated ? 1 : 0;
  const stderrTruncated: 0 | 1 = envelope.stderrTruncated ? 1 : 0;
  return { execution_id: executionId, case_id: caseId, implementation_id: implementationId, status: execution.status, exit_code: envelope.exitCode, signal: envelope.signal, wall_ns: ns(envelope.wallTimeMs), cpu_ns: ns(envelope.cpuTimeMs), peak_memory_bytes: BigInt(Math.trunc(envelope.memoryPeakBytes)), stdout_bytes: BigInt(envelope.stdoutBytes), stderr_bytes: BigInt(envelope.stderrBytes), stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, limit_cause: null, raw_json: JSON.stringify(envelope) };
}
function ns(value: number): bigint | null { return Number.isFinite(value) && value >= 0 ? BigInt(Math.trunc(value * 1_000_000)) : null; }
function isDescendant(root: string, candidate: string): boolean { const value = relative(resolve(root), candidate); return value !== ".." && !value.startsWith(`..${sep}`); }
function confined(root: string, path: string): string { const value = relative(root, path); if (value === "" || value === ".." || value.startsWith(`..${sep}`)) throw new Error("recorded asset escapes problem root"); return value.split(sep).join("/"); }
function samePredicate(a: FailurePredicate, b: FailurePredicate): boolean { return a.kind === b.kind && a.naiveStatus === b.naiveStatus && a.solutionStatus === b.solutionStatus && a.mismatchPath === b.mismatchPath && a.mismatchReason === b.mismatchReason; }
function identifier(d: ReplayDependencies): string { return (d.createId ?? randomUUID)(); }
function failure(status: ExecutionStatus, code: string, message: string): ReplayOutcome { return { status, result: null, diagnostics: [{ code, message }] }; }
