/** Deterministic differential stress-test command service. */

import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { CanonicalValue } from "../judging/value/index.js";
import type { ComparisonPolicy, ExecutionStatus, RawProcessResult, ResourceLimits, RunId, TerminationCause } from "../domain/index.js";
import { initialGeneration, toCaseId, toRunId } from "../domain/index.js";
import type { CancellationToken, Clock, RuntimeBundle } from "../execution/ports/index.js";
import { assertConfigurationValid, loadProblemConfig, parseEnvOverrides, resolveEffectiveConfig, type ConfigProbes, type EffectiveConfig, type EnvironmentRecord, type PathContext } from "../infrastructure/config/index.js";
import { createOutputComparator } from "../judging/comparator/index.js";
import { decodeRequestLine, encodeRequestLine } from "../judging/codec/index.js";
import type { PersistenceRecords, TransactionScope } from "../persistence/ports/index.js";
import { executeIsolated, executeEncodedIsolated, sha256Bytes, type IsolatedExecution } from "./isolated-execution.js";
import { type FailurePredicate, FUZZ_ARTIFACT_SCHEMA_VERSION, type FuzzArtifactDocument, type FuzzExecutionEnvelope, type ShrinkResult, writeFuzzArtifact } from "./fuzz-artifact.js";

export const DEFAULT_STRESS_CASES = 10_000;
export const DEFAULT_STRESS_DURATION_MS = 60_000;
export const SHRINK_STEP_CAP = 10_000;
export const SHRINK_DURATION_MS = 10_000;

/** CLI-decoupled stress invocation. */
export interface StressTestInvocation {
  readonly slug: string;
  readonly generator?: string;
  readonly naive?: string;
  readonly solution?: string;
  readonly seed?: string;
  readonly cases?: number;
  readonly duration?: number;
  readonly jobs?: number;
  readonly shrink: boolean;
  readonly unsafeLocal: boolean;
}

export interface StressTestResult {
  readonly runId: string;
  readonly seed: string;
  readonly completedCases: number;
  readonly caseLimit: number;
  readonly durationLimitMs: number;
  readonly finding: { readonly caseIndex: number; readonly artifactId: string | null; readonly predicate: FailurePredicate } | null;
  /** Present only for a failed reference; CLI maps this special result to exit 2. */
  readonly oracleFailure: { readonly status: "oracle_failure"; readonly executionStatus: ExecutionStatus; readonly envelope: FuzzExecutionEnvelope } | null;
}

export interface StressTestOutcome {
  readonly status: ExecutionStatus;
  readonly result: StressTestResult | null;
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

/** Concrete transaction rows required for a persisted stress finding. */
export interface StressPersistenceRecords extends PersistenceRecords {
  readonly problem: { readonly problem_id: string; readonly slug: string; readonly schema_version: number; readonly title: string; readonly created_at: string; readonly updated_at: string };
  readonly implementation: { readonly implementation_id: string; readonly problem_id: string; readonly path: string; readonly role: string; readonly content_sha256: string; readonly runtime: string; readonly created_at: string };
  readonly case: { readonly case_id: string; readonly run_id: string; readonly ordinal: number; readonly input_sha256: string; readonly input_bytes: bigint; readonly status: string };
  readonly execution: { readonly execution_id: string; readonly case_id: string; readonly implementation_id: string; readonly status: string; readonly exit_code: number | null; readonly signal: string | null; readonly wall_ns: bigint | null; readonly cpu_ns: bigint | null; readonly peak_memory_bytes: bigint | null; readonly stdout_bytes: bigint | null; readonly stderr_bytes: bigint | null; readonly stdout_truncated: 0 | 1 | null; readonly stderr_truncated: 0 | 1 | null; readonly limit_cause: string | null; readonly raw_json: string | null };
  readonly artifact: { readonly artifact_id: string; readonly run_id: string; readonly kind: string; readonly path: string; readonly sha256: string; readonly size_bytes: bigint; readonly created_at: string };
  readonly replay: unknown;
}

export interface StressTestDependencies {
  readonly invocationDirectory: string;
  readonly environment: EnvironmentRecord;
  readonly cancellation: CancellationToken;
  readonly clock: Clock;
  readonly probes: ConfigProbes;
  readonly supportedRuntimes: ReadonlySet<string>;
  readonly requiredControls: readonly ("cgroup" | "rlimits" | "network" | "filesystem" | "no-new-privileges" | "drop-capabilities" | "namespaces" | "seccomp")[];
  readonly createBundle: (effective: EffectiveConfig) => RuntimeBundle;
  readonly transaction: TransactionScope<StressPersistenceRecords>;
  readonly classifyTermination: (raw: RawProcessResult, limits: ResourceLimits) => TerminationCause;
  readonly createId?: () => string;
  readonly chooseSeed?: () => string;
  readonly telemetry?: (event: "fuzz.case" | "fuzz.mismatch" | "fuzz.shrink", data: Readonly<Record<string, string | number | boolean | null>>) => void;
}

interface Prepared { readonly effective: EffectiveConfig; readonly bundle: RuntimeBundle; readonly generator: string; readonly naive: string; readonly solution: string; }
interface Finding { readonly index: number; readonly caseId: string; readonly input: CanonicalValue; readonly encoded: Uint8Array; readonly naive: IsolatedExecution; readonly solution: IsolatedExecution; readonly predicate: FailurePredicate; }

/** Run deterministic cases sequentially. `jobs` is intentionally bounded to this deterministic implementation. */
export async function executeStressTestCommand(command: StressTestInvocation, dependencies: StressTestDependencies): Promise<StressTestOutcome> {
  const diagnostics: { code: string; message: string }[] = [];
  try {
    const prepared = await prepare(command, dependencies);
    const runId = toRunId(id(dependencies));
    const seed = canonicalSeed(command.seed ?? dependencies.chooseSeed?.() ?? randomSeed());
    const maxCases = command.cases ?? DEFAULT_STRESS_CASES;
    const duration = command.duration ?? DEFAULT_STRESS_DURATION_MS;
    const started = dependencies.clock.monotonicNs();
    const cases = await executeCases(prepared, runId, seed, maxCases, duration, command.jobs ?? 1, started, dependencies);
    if (cases.canceled) return canceled(runId, seed, cases.completedCases, maxCases, duration);
    const { completedCases, finding } = cases;
    if (finding === null) return success(runId, seed, completedCases, maxCases, duration);
    let minimized = finding.input;
    let shrink: ShrinkResult = { requested: command.shrink, steps: 0, reason: command.shrink ? "complete" : "not_requested", originalBytes: finding.encoded.length, minimizedBytes: finding.encoded.length };
    if (command.shrink) {
      const shrunk = await shrinkFinding(prepared, runId, finding, dependencies);
      minimized = shrunk.input; shrink = shrunk.result;
      dependencies.telemetry?.("fuzz.shrink", { seed, caseIndex: finding.index, steps: shrink.steps, reason: shrink.reason });
    }
    const artifactId = await persistFinding(prepared, runId, seed, finding, minimized, shrink, dependencies, diagnostics);
    dependencies.telemetry?.("fuzz.mismatch", { seed, caseIndex: finding.index, predicate: finding.predicate.kind, artifactId });
    const oracleFailure = finding.predicate.kind === "oracle_failure" ? { status: "oracle_failure" as const, executionStatus: finding.naive.status, envelope: finding.naive.envelope } : null;
    return Object.freeze({ status: oracleFailure === null ? finding.solution.status === "passed" ? "wrong_answer" : finding.solution.status : "nonzero_exit", result: Object.freeze({ runId, seed, completedCases, caseLimit: maxCases, durationLimitMs: duration, finding: { caseIndex: finding.index, artifactId, predicate: finding.predicate }, oracleFailure }), diagnostics: Object.freeze(diagnostics) });
  } catch (error) {
    return Object.freeze({ status: "invalid_input", result: null, diagnostics: Object.freeze([{ code: "stress_configuration_error", message: message(error) }]) });
  }
}

async function prepare(command: StressTestInvocation, d: StressTestDependencies): Promise<Prepared> {
  const declared = `${d.invocationDirectory}/problems/${command.slug}`;
  const root = await realpath(declared);
  const problem = loadProblemConfig(await readFile(`${root}/problem.yaml`, "utf8"));
  if (problem.slug !== command.slug) throw new Error("problem.yaml slug does not match requested slug");
  const effective = resolveEffectiveConfig({ problem, env: parseEnvOverrides(d.environment), cli: { unsafeLocal: command.unsafeLocal, ...(command.generator === undefined ? {} : { generator: command.generator }), ...(command.naive === undefined ? {} : { naive: command.naive }), ...(command.solution === undefined ? {} : { solution: command.solution }) }, context: { invocationDir: d.invocationDirectory, problemRoot: root } satisfies PathContext });
  await assertConfigurationValid({ effective, probes: d.probes, supportedRuntimes: d.supportedRuntimes, requiredControls: d.requiredControls });
  if (effective.assets.generator === undefined || effective.assets.naive === undefined) throw new Error("stress-test requires generator and naive assets");
  return Object.freeze({ effective, bundle: d.createBundle(effective), generator: relativePath(root, await realpath(effective.assets.generator)), naive: relativePath(root, await realpath(effective.assets.naive)), solution: relativePath(root, await realpath(effective.assets.entrypoint)) });
}

/**
 * Run sequentially by default. Concurrent workers claim monotonically increasing
 * indices; once any worker finds an actionable result they stop claiming work,
 * drain their already-started invocation, and choose the smallest finding.
 */
async function executeCases(prepared: Prepared, runId: RunId, seed: string, maxCases: number, duration: number, jobs: number, started: bigint, d: StressTestDependencies): Promise<{ readonly completedCases: number; readonly finding: Finding | null; readonly canceled: boolean }> {
  const workerCount = Math.max(1, Math.min(jobs, maxCases));
  let nextIndex = 0; let completedCases = 0; let stopped = false; let canceled = false;
  const findings: Finding[] = [];
  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < maxCases && elapsedMs(started, d.clock.monotonicNs()) < duration) {
      if (d.cancellation.isCancellationRequested) { canceled = true; stopped = true; return; }
      const index = nextIndex; nextIndex += 1;
      const candidate = await runCase(prepared, runId, index, seed, d);
      completedCases += 1;
      d.telemetry?.("fuzz.case", { seed, caseIndex: index, status: candidate.predicate?.kind ?? "passed" });
      if (candidate.finding !== null) { findings.push(candidate.finding); stopped = true; }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  findings.sort((left, right) => left.index - right.index);
  return Object.freeze({ completedCases, finding: findings[0] ?? null, canceled });
}

async function runCase(prepared: Prepared, runId: RunId, index: number, seed: string, d: StressTestDependencies): Promise<{ readonly predicate: FailurePredicate | null; readonly finding: Finding | null }> {
  const caseId = toCaseId(id(d));
  const base = { runId, caseId, problemFingerprint: prepared.effective.problem.slug, inputCodecVersion: prepared.effective.problem.inputCodec, outputCodecVersion: prepared.effective.problem.outputCodec, limits: prepared.effective.limits, generation: initialGeneration() };
  const generator = await executeIsolated(prepared.effective, { ...base, implementation: { role: "generator", relativePath: prepared.generator } }, { tag: "int", value: caseSeed(seed, index) }, { bundle: prepared.bundle, cancellation: d.cancellation, classifyTermination: d.classifyTermination });
  if (generator.status !== "passed" || generator.output === null || generator.exception !== null) throw new Error("generator failed to produce a canonical input");
  const decoded = decodeRequestLine(generator.requestBytes);
  if (!decoded.ok) throw new Error("generator request was not canonical");
  const naive = await executeIsolated(prepared.effective, { ...base, implementation: { role: "naive", relativePath: prepared.naive } }, generator.output, { bundle: prepared.bundle, cancellation: d.cancellation, classifyTermination: d.classifyTermination });
  const solution = await executeEncodedIsolated(prepared.effective, { ...base, implementation: { role: "solution", relativePath: prepared.solution }, inputBytes: naive.requestBytes }, { bundle: prepared.bundle, cancellation: d.cancellation, classifyTermination: d.classifyTermination });
  const predicate = predicateOf(prepared.effective.problem.comparisonPolicy, naive, solution);
  return { predicate, finding: predicate === null ? null : { index, caseId: String(caseId), input: generator.output, encoded: naive.requestBytes, naive, solution, predicate } };
}

function predicateOf(version: string, naive: IsolatedExecution, solution: IsolatedExecution): FailurePredicate | null {
  if (naive.status !== "passed" || naive.exception !== null || naive.output === null) return { kind: "oracle_failure", naiveStatus: naive.status, solutionStatus: solution.status, mismatchPath: null, mismatchReason: null };
  if (solution.status !== "passed" || solution.exception !== null || solution.output === null) return { kind: "optimized_failure", naiveStatus: naive.status, solutionStatus: solution.status, mismatchPath: null, mismatchReason: null };
  const comparison = createOutputComparator().compare(naive.output, solution.output, { version, equality: "semantic", normalizeWhitespace: false } satisfies ComparisonPolicy);
  return comparison.equal ? null : { kind: "mismatch", naiveStatus: naive.status, solutionStatus: solution.status, mismatchPath: comparison.mismatch.path, mismatchReason: comparison.mismatch.reason };
}

/** Candidate strategy: recursively remove one contiguous half of a list/tuple. */
async function shrinkFinding(prepared: Prepared, runId: RunId, finding: Finding, d: StressTestDependencies): Promise<{ readonly input: CanonicalValue; readonly result: ShrinkResult }> {
  let best = finding.input; let steps = 0; const started = d.clock.monotonicNs(); let reason: ShrinkResult["reason"] = "complete";
  for (const candidate of shrinkCandidates(best)) {
    if (steps >= SHRINK_STEP_CAP) { reason = "step_cap"; break; }
    if (elapsedMs(started, d.clock.monotonicNs()) >= SHRINK_DURATION_MS) { reason = "time_cap"; break; }
    steps += 1;
    const candidateFinding = await rerunInput(prepared, runId, finding.caseId, candidate, d);
    if (candidateFinding !== null && samePredicate(candidateFinding.predicate, finding.predicate)) best = candidate;
  }
  const encoded = encodeRequestLine({ protocolVersion: 1, kind: "request", runId, caseId: finding.caseId, codecVersion: prepared.effective.problem.inputCodec, messageLimitBytes: prepared.effective.limits.inputBytes, input: best });
  return { input: best, result: { requested: true, steps, reason, originalBytes: finding.encoded.length, minimizedBytes: encoded.length } }; 
}

async function rerunInput(prepared: Prepared, runId: RunId, caseId: string, input: CanonicalValue, d: StressTestDependencies): Promise<Finding | null> {
  const base = { runId, caseId: toCaseId(caseId), problemFingerprint: prepared.effective.problem.slug, inputCodecVersion: prepared.effective.problem.inputCodec, outputCodecVersion: prepared.effective.problem.outputCodec, limits: prepared.effective.limits, generation: initialGeneration() };
  const naive = await executeIsolated(prepared.effective, { ...base, implementation: { role: "naive", relativePath: prepared.naive } }, input, { bundle: prepared.bundle, cancellation: d.cancellation, classifyTermination: d.classifyTermination });
  const solution = await executeEncodedIsolated(prepared.effective, { ...base, implementation: { role: "solution", relativePath: prepared.solution }, inputBytes: naive.requestBytes }, { bundle: prepared.bundle, cancellation: d.cancellation, classifyTermination: d.classifyTermination });
  const predicate = predicateOf(prepared.effective.problem.comparisonPolicy, naive, solution);
  return predicate === null ? null : { index: 0, caseId, input, encoded: naive.requestBytes, naive, solution, predicate };
}

function shrinkCandidates(value: CanonicalValue): readonly CanonicalValue[] {
  if (value.tag !== "list" && value.tag !== "tuple") return [];
  const items = value.items; if (items.length < 2) return [];
  const half = Math.ceil(items.length / 2);
  return Object.freeze([{ ...value, items: items.slice(0, half) }, { ...value, items: items.slice(half) }]);
}
function samePredicate(left: FailurePredicate, right: FailurePredicate): boolean { return left.kind === right.kind && left.naiveStatus === right.naiveStatus && left.solutionStatus === right.solutionStatus && left.mismatchPath === right.mismatchPath && left.mismatchReason === right.mismatchReason; }

async function persistFinding(prepared: Prepared, runId: RunId, seed: string, finding: Finding, minimized: CanonicalValue, shrink: ShrinkResult, d: StressTestDependencies, diagnostics: { code: string; message: string }[]): Promise<string | null> {
  const document: FuzzArtifactDocument = { schemaVersion: FUZZ_ARTIFACT_SCHEMA_VERSION, kind: "fuzz-finding", sourceRunId: String(runId), sourceCaseId: finding.caseId, slug: prepared.effective.problem.slug, seed, caseIndex: finding.index, inputCodecVersion: prepared.effective.problem.inputCodec, outputCodecVersion: prepared.effective.problem.outputCodec, comparatorVersion: prepared.effective.problem.comparisonPolicy, runtime: prepared.effective.problem.runtime, limits: prepared.effective.limits, generatorPath: prepared.generator, naivePath: prepared.naive, solutionPath: prepared.solution, originalInputBase64Url: Buffer.from(finding.encoded).toString("base64url"), minimizedInputBase64Url: Buffer.from(encodeRequestLine({ protocolVersion: 1, kind: "request", runId: String(runId), caseId: finding.caseId, codecVersion: prepared.effective.problem.inputCodec, messageLimitBytes: prepared.effective.limits.inputBytes, input: minimized })).toString("base64url"), predicate: finding.predicate, naive: finding.naive.envelope, solution: finding.solution.envelope, shrink, createdAt: d.clock.wallTimeUtc() };
  let artifact;
  try { artifact = await writeFuzzArtifact(d.invocationDirectory, document, parseEnvOverrides(d.environment).artifactStorageCapBytes); } catch (error) { diagnostics.push({ code: "artifact_write_failed", message: message(error) }); return null; }
  try {
    const now = d.clock.wallTimeUtc(); const problemId = `problem-${prepared.effective.problem.slug}`;
    await d.transaction.transact(async uow => {
      const existing = await uow.problems.findBySlug(prepared.effective.problem.slug);
      if (existing === null) await uow.problems.register({ problem_id: problemId, slug: prepared.effective.problem.slug, schema_version: prepared.effective.problem.schemaVersion, title: prepared.effective.problem.title, created_at: now, updated_at: now });
      const persistedProblem = existing?.problem_id ?? problemId;
      const implementationIds: Record<string, string> = {};
      for (const [role, path] of [["naive", prepared.naive], ["solution", prepared.solution]] as const) { const content = await readFile(`${prepared.effective.problemRoot}/${path}`, "utf8"); const implementationId = `implementation-${sha256Bytes(new TextEncoder().encode(content))}`; implementationIds[role] = implementationId; await uow.implementations.register({ implementation_id: implementationId, problem_id: persistedProblem, path, role, content_sha256: sha256Bytes(new TextEncoder().encode(content)), runtime: prepared.effective.problem.runtime, created_at: now }); }
      await uow.runs.commit({ runId, slug: prepared.effective.problem.slug, state: "failed", status: finding.predicate.kind === "mismatch" ? "wrong_answer" : finding.predicate.kind === "oracle_failure" ? "nonzero_exit" : finding.solution.status, problemFingerprint: prepared.effective.problem.slug, seed, limits: prepared.effective.limits, inputCodecVersion: prepared.effective.problem.inputCodec, outputCodecVersion: prepared.effective.problem.outputCodec, comparisonPolicyVersion: prepared.effective.problem.comparisonPolicy, inputHash: sha256Bytes(finding.encoded), outputHash: null, generation: initialGeneration(), wallTimeUtc: now, durationMs: 0 });
      await uow.cases.commit({ case_id: finding.caseId, run_id: String(runId), ordinal: finding.index, input_sha256: sha256Bytes(finding.encoded), input_bytes: BigInt(finding.encoded.length), status: finding.predicate.kind === "mismatch" ? "wrong_answer" : finding.solution.status });
      for (const [role, execution] of [["naive", finding.naive], ["solution", finding.solution]] as const) await uow.executions.commit(executionRow(id(d), finding.caseId, implementationIds[role]!, execution));
      await uow.artifacts.commit({ artifact_id: artifact.artifactId, run_id: String(runId), kind: "fuzz-finding", path: artifact.path, sha256: artifact.sha256, size_bytes: artifact.sizeBytes, created_at: now });
    });
  } catch (error) { diagnostics.push({ code: "persistence_failed", message: message(error) }); }
  return artifact.artifactId;
}
function executionRow(executionId: string, caseId: string, implementationId: string, execution: IsolatedExecution) {
  const e = execution.envelope;
  const stdoutTruncated: 0 | 1 = e.stdoutTruncated ? 1 : 0;
  const stderrTruncated: 0 | 1 = e.stderrTruncated ? 1 : 0;
  return { execution_id: executionId, case_id: caseId, implementation_id: implementationId, status: execution.status, exit_code: e.exitCode, signal: e.signal, wall_ns: toNs(e.wallTimeMs), cpu_ns: toNs(e.cpuTimeMs), peak_memory_bytes: BigInt(Math.trunc(e.memoryPeakBytes)), stdout_bytes: BigInt(e.stdoutBytes), stderr_bytes: BigInt(e.stderrBytes), stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, limit_cause: null, raw_json: JSON.stringify(e) };
}
function relativePath(root: string, path: string): string { const value = relative(root, path); if (value === "" || value === ".." || value.startsWith(`..${sep}`)) throw new Error("asset escapes problem root"); return value.split(sep).join("/"); }
function randomSeed(): string { return BigInt(`0x${randomBytes(8).toString("hex")}`).toString(10); }
function canonicalSeed(value: string): string { if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > (1n << 64n) - 1n) throw new Error("seed is not uint64"); return BigInt(value).toString(10); }
function caseSeed(seed: string, index: number): bigint { return (BigInt(seed) + BigInt(index)) & ((1n << 64n) - 1n); }
function elapsedMs(start: bigint, end: bigint): number { return Number(end - start) / 1_000_000; }
function id(d: StressTestDependencies): string { return (d.createId ?? randomUUID)(); }
function toNs(ms: number): bigint | null { return Number.isFinite(ms) && ms >= 0 ? BigInt(Math.trunc(ms * 1_000_000)) : null; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function success(runId: string, seed: string, completedCases: number, caseLimit: number, durationLimitMs: number): StressTestOutcome { return { status: "passed", result: { runId, seed, completedCases, caseLimit, durationLimitMs, finding: null, oracleFailure: null }, diagnostics: [] }; }
function canceled(runId: string, seed: string, completedCases: number, caseLimit: number, durationLimitMs: number): StressTestOutcome { return { status: "canceled", result: { runId, seed, completedCases, caseLimit, durationLimitMs, finding: null, oracleFailure: null }, diagnostics: [] }; }
