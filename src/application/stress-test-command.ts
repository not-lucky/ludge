import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { CanonicalValue } from "../judging/value/model.js";
import type {
  ComparisonPolicy,
  ExecutionStatus,
  RawProcessResult,
  ResourceLimits,
  RunId,
  TerminationCause,
} from "../domain/index.js";
import { initialGeneration, toCaseId, toRunId } from "../domain/index.js";
import type { CancellationToken } from "../execution/cancellation.js";
import type { Clock } from "../execution/clock.js";
import type { Runner } from "../execution/runner.js";
import type { RunContext } from "../infrastructure/problem.js";
import {
  prepareRunContext,
  type PreparedRunContext,
  type PrepareRunOptions,
} from "./run-context.js";
import { createOutputComparator } from "../judging/comparator/index.js";
import {
  decodeRequestLine,
  encodeRequestLine,
} from "../judging/codec/index.js";
import type { SqliteTransactionScope } from "../persistence/sqlite/transaction-scope.js";
import {
  executeCase,
  executeEncodedCase,
  sha256Bytes,
  type IsolatedExecution,
} from "./execute-case.js";
import {
  type FailurePredicate,
  FUZZ_ARTIFACT_SCHEMA_VERSION,
  type FuzzArtifactDocument,
  type FuzzExecutionEnvelope,
  type ShrinkResult,
  writeFuzzArtifact,
} from "./fuzz-artifact.js";

export const DEFAULT_STRESS_CASES = 10_000;
export const DEFAULT_STRESS_DURATION_MS = 60_000;
export const SHRINK_STEP_CAP = 10_000;
export const SHRINK_DURATION_MS = 10_000;

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
  readonly finding: {
    readonly caseIndex: number;
    readonly artifactId: string | null;
    readonly predicate: FailurePredicate;
  } | null;
  readonly oracleFailure: {
    readonly status: "oracle_failure";
    readonly executionStatus: ExecutionStatus;
    readonly envelope: FuzzExecutionEnvelope;
  } | null;
}

export interface StressTestOutcome {
  readonly status: ExecutionStatus;
  readonly result: StressTestResult | null;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

export interface StressTestDependencies {
  readonly invocationDirectory: string;
  readonly cancellation: CancellationToken;
  readonly clock: Clock;
  readonly prepareRun?: (
    options: PrepareRunOptions,
  ) => Promise<PreparedRunContext>;
  readonly transaction: Pick<SqliteTransactionScope, "transact">;
  readonly classifyTermination: (
    raw: RawProcessResult,
    limits: ResourceLimits,
  ) => TerminationCause;
  readonly createId?: () => string;
  readonly chooseSeed?: () => string;
  readonly telemetry?: (
    event: "fuzz.case" | "fuzz.mismatch" | "fuzz.shrink",
    data: Readonly<Record<string, string | number | boolean | null>>,
  ) => void;
}

interface Prepared {
  readonly context: RunContext;
  readonly runner: Runner;
  readonly generator: string;
  readonly naive: string;
  readonly solution: string;
}
interface Finding {
  readonly index: number;
  readonly caseId: string;
  readonly input: CanonicalValue;
  readonly encoded: Uint8Array;
  readonly naive: IsolatedExecution;
  readonly solution: IsolatedExecution;
  readonly predicate: FailurePredicate;
}

export async function executeStressTestCommand(
  command: StressTestInvocation,
  dependencies: StressTestDependencies,
): Promise<StressTestOutcome> {
  const diagnostics: { code: string; message: string }[] = [];
  try {
    const prepared = await prepare(command, dependencies);
    const runId = toRunId(id(dependencies));
    const seed = canonicalSeed(
      command.seed ?? dependencies.chooseSeed?.() ?? randomSeed(),
    );
    const maxCases = command.cases ?? DEFAULT_STRESS_CASES;
    const duration = command.duration ?? DEFAULT_STRESS_DURATION_MS;
    const started = dependencies.clock.monotonicNs();
    const cases = await executeCases(
      prepared,
      runId,
      seed,
      maxCases,
      duration,
      command.jobs ?? 1,
      started,
      dependencies,
    );
    if (cases.canceled)
      return canceled(runId, seed, cases.completedCases, maxCases, duration);
    const { completedCases, finding } = cases;
    if (finding === null)
      return success(runId, seed, completedCases, maxCases, duration);
    let minimized = finding.input;
    let shrink: ShrinkResult = {
      requested: command.shrink,
      steps: 0,
      reason: command.shrink ? "complete" : "not_requested",
      originalBytes: finding.encoded.length,
      minimizedBytes: finding.encoded.length,
    };
    if (command.shrink) {
      const shrunk = await shrinkFinding(
        prepared,
        runId,
        finding,
        dependencies,
      );
      minimized = shrunk.input;
      shrink = shrunk.result;
      dependencies.telemetry?.("fuzz.shrink", {
        seed,
        caseIndex: finding.index,
        steps: shrink.steps,
        reason: shrink.reason,
      });
    }
    const artifactId = await persistFinding(
      prepared,
      runId,
      seed,
      finding,
      minimized,
      shrink,
      dependencies,
      diagnostics,
    );
    dependencies.telemetry?.("fuzz.mismatch", {
      seed,
      caseIndex: finding.index,
      predicate: finding.predicate.kind,
      artifactId,
    });
    const oracleFailure =
      finding.predicate.kind === "oracle_failure"
        ? {
            status: "oracle_failure" as const,
            executionStatus: finding.naive.status,
            envelope: finding.naive.envelope,
          }
        : null;
    return Object.freeze({
      status:
        oracleFailure === null
          ? finding.solution.status === "passed"
            ? "wrong_answer"
            : finding.solution.status
          : "nonzero_exit",
      result: Object.freeze({
        runId,
        seed,
        completedCases,
        caseLimit: maxCases,
        durationLimitMs: duration,
        finding: {
          caseIndex: finding.index,
          artifactId,
          predicate: finding.predicate,
        },
        oracleFailure,
      }),
      diagnostics: Object.freeze(diagnostics),
    });
  } catch (error) {
    return Object.freeze({
      status: "invalid_input",
      result: null,
      diagnostics: Object.freeze([
        { code: "stress_configuration_error", message: message(error) },
      ]),
    });
  }
}

async function prepare(
  command: StressTestInvocation,
  d: StressTestDependencies,
): Promise<Prepared> {
  const prepared = await (d.prepareRun ?? prepareRunContext)({
    invocationDirectory: d.invocationDirectory,
    slug: command.slug,
    unsafeLocal: command.unsafeLocal,
    ...(command.generator === undefined
      ? {}
      : { generator: command.generator }),
    ...(command.naive === undefined ? {} : { naive: command.naive }),
    ...(command.solution === undefined ? {} : { solution: command.solution }),
  });
  const { context } = prepared;
  if (
    context.assets.generator === undefined ||
    context.assets.naive === undefined
  ) {
    throw new Error("stress-test requires generator and naive assets");
  }
  return {
    context,
    runner: prepared.runner,
    generator: relativePath(
      context.problemRoot,
      await realpath(context.assets.generator),
    ),
    naive: relativePath(
      context.problemRoot,
      await realpath(context.assets.naive),
    ),
    solution: relativePath(
      context.problemRoot,
      await realpath(context.assets.entrypoint),
    ),
  };
}

async function executeCases(
  prepared: Prepared,
  runId: RunId,
  seed: string,
  maxCases: number,
  duration: number,
  jobs: number,
  started: bigint,
  d: StressTestDependencies,
): Promise<{
  readonly completedCases: number;
  readonly finding: Finding | null;
  readonly canceled: boolean;
}> {
  const workerCount = Math.max(1, Math.min(jobs, maxCases));
  let nextIndex = 0;
  let completedCases = 0;
  let stopped = false;
  let canceled = false;
  const findings: Finding[] = [];
  const worker = async (): Promise<void> => {
    while (
      !stopped &&
      nextIndex < maxCases &&
      elapsedMs(started, d.clock.monotonicNs()) < duration
    ) {
      if (d.cancellation.isCancellationRequested) {
        canceled = true;
        stopped = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      const candidate = await runCase(prepared, runId, index, seed, d);
      completedCases += 1;
      d.telemetry?.("fuzz.case", {
        seed,
        caseIndex: index,
        status: candidate.predicate?.kind ?? "passed",
      });
      if (candidate.finding !== null) {
        findings.push(candidate.finding);
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  findings.sort((left, right) => left.index - right.index);
  return Object.freeze({
    completedCases,
    finding: findings[0] ?? null,
    canceled,
  });
}

async function runCase(
  prepared: Prepared,
  runId: RunId,
  index: number,
  seed: string,
  d: StressTestDependencies,
): Promise<{
  readonly predicate: FailurePredicate | null;
  readonly finding: Finding | null;
}> {
  const caseId = toCaseId(id(d));
  const base = {
    runId,
    caseId,
    problemFingerprint: prepared.context.problem.slug,
    inputCodecVersion: prepared.context.problem.inputCodec,
    outputCodecVersion: prepared.context.problem.outputCodec,
    limits: prepared.context.limits,
    generation: initialGeneration(),
  };
  const generator = await executeCase(
    prepared.context,
    {
      ...base,
      implementation: { role: "generator", relativePath: prepared.generator },
    },
    { tag: "int", value: caseSeed(seed, index) },
    {
      runner: prepared.runner,
      cancellation: d.cancellation,
      classifyTermination: d.classifyTermination,
    },
  );
  if (
    generator.status !== "passed" ||
    generator.output === null ||
    generator.exception !== null
  )
    throw new Error("generator failed to produce a canonical input");
  const decoded = decodeRequestLine(generator.requestBytes);
  if (!decoded.ok) throw new Error("generator request was not canonical");
  const naive = await executeCase(
    prepared.context,
    {
      ...base,
      implementation: { role: "naive", relativePath: prepared.naive },
    },
    generator.output,
    {
      runner: prepared.runner,
      cancellation: d.cancellation,
      classifyTermination: d.classifyTermination,
    },
  );
  const solution = await executeEncodedCase(
    prepared.context,
    {
      ...base,
      implementation: { role: "solution", relativePath: prepared.solution },
      inputBytes: naive.requestBytes,
    },
    {
      runner: prepared.runner,
      cancellation: d.cancellation,
      classifyTermination: d.classifyTermination,
    },
  );
  const predicate = predicateOf(
    prepared.context.problem.comparisonPolicy,
    naive,
    solution,
  );
  return {
    predicate,
    finding:
      predicate === null
        ? null
        : {
            index,
            caseId: String(caseId),
            input: generator.output,
            encoded: naive.requestBytes,
            naive,
            solution,
            predicate,
          },
  };
}

function predicateOf(
  version: string,
  naive: IsolatedExecution,
  solution: IsolatedExecution,
): FailurePredicate | null {
  if (
    naive.status !== "passed" ||
    naive.exception !== null ||
    naive.output === null
  )
    return {
      kind: "oracle_failure",
      naiveStatus: naive.status,
      solutionStatus: solution.status,
      mismatchPath: null,
      mismatchReason: null,
    };
  if (
    solution.status !== "passed" ||
    solution.exception !== null ||
    solution.output === null
  )
    return {
      kind: "optimized_failure",
      naiveStatus: naive.status,
      solutionStatus: solution.status,
      mismatchPath: null,
      mismatchReason: null,
    };
  const comparison = createOutputComparator().compare(
    naive.output,
    solution.output,
    {
      version,
      equality: "semantic",
      normalizeWhitespace: false,
    } satisfies ComparisonPolicy,
  );
  return comparison.equal
    ? null
    : {
        kind: "mismatch",
        naiveStatus: naive.status,
        solutionStatus: solution.status,
        mismatchPath: comparison.mismatch.path,
        mismatchReason: comparison.mismatch.reason,
      };
}

async function shrinkFinding(
  prepared: Prepared,
  runId: RunId,
  finding: Finding,
  d: StressTestDependencies,
): Promise<{ readonly input: CanonicalValue; readonly result: ShrinkResult }> {
  let best = finding.input;
  let steps = 0;
  const started = d.clock.monotonicNs();
  let reason: ShrinkResult["reason"] = "complete";
  for (const candidate of shrinkCandidates(best)) {
    if (steps >= SHRINK_STEP_CAP) {
      reason = "step_cap";
      break;
    }
    if (elapsedMs(started, d.clock.monotonicNs()) >= SHRINK_DURATION_MS) {
      reason = "time_cap";
      break;
    }
    steps += 1;
    const candidateFinding = await rerunInput(
      prepared,
      runId,
      finding.caseId,
      candidate,
      d,
    );
    if (
      candidateFinding !== null &&
      samePredicate(candidateFinding.predicate, finding.predicate)
    )
      best = candidate;
  }
  const encoded = encodeRequestLine({
    protocolVersion: 1,
    kind: "request",
    runId,
    caseId: finding.caseId,
    codecVersion: prepared.context.problem.inputCodec,
    messageLimitBytes: prepared.context.limits.inputBytes,
    input: best,
  });
  return {
    input: best,
    result: {
      requested: true,
      steps,
      reason,
      originalBytes: finding.encoded.length,
      minimizedBytes: encoded.length,
    },
  };
}

async function rerunInput(
  prepared: Prepared,
  runId: RunId,
  caseId: string,
  input: CanonicalValue,
  d: StressTestDependencies,
): Promise<Finding | null> {
  const base = {
    runId,
    caseId: toCaseId(caseId),
    problemFingerprint: prepared.context.problem.slug,
    inputCodecVersion: prepared.context.problem.inputCodec,
    outputCodecVersion: prepared.context.problem.outputCodec,
    limits: prepared.context.limits,
    generation: initialGeneration(),
  };
  const naive = await executeCase(
    prepared.context,
    {
      ...base,
      implementation: { role: "naive", relativePath: prepared.naive },
    },
    input,
    {
      runner: prepared.runner,
      cancellation: d.cancellation,
      classifyTermination: d.classifyTermination,
    },
  );
  const solution = await executeEncodedCase(
    prepared.context,
    {
      ...base,
      implementation: { role: "solution", relativePath: prepared.solution },
      inputBytes: naive.requestBytes,
    },
    {
      runner: prepared.runner,
      cancellation: d.cancellation,
      classifyTermination: d.classifyTermination,
    },
  );
  const predicate = predicateOf(
    prepared.context.problem.comparisonPolicy,
    naive,
    solution,
  );
  return predicate === null
    ? null
    : {
        index: 0,
        caseId,
        input,
        encoded: naive.requestBytes,
        naive,
        solution,
        predicate,
      };
}

function shrinkCandidates(value: CanonicalValue): readonly CanonicalValue[] {
  if (value.tag !== "list" && value.tag !== "tuple") return [];
  const items = value.items;
  if (items.length < 2) return [];
  const half = Math.ceil(items.length / 2);
  return Object.freeze([
    { ...value, items: items.slice(0, half) },
    { ...value, items: items.slice(half) },
  ]);
}
function samePredicate(
  left: FailurePredicate,
  right: FailurePredicate,
): boolean {
  return (
    left.kind === right.kind &&
    left.naiveStatus === right.naiveStatus &&
    left.solutionStatus === right.solutionStatus &&
    left.mismatchPath === right.mismatchPath &&
    left.mismatchReason === right.mismatchReason
  );
}

async function persistFinding(
  prepared: Prepared,
  runId: RunId,
  seed: string,
  finding: Finding,
  minimized: CanonicalValue,
  shrink: ShrinkResult,
  d: StressTestDependencies,
  diagnostics: { code: string; message: string }[],
): Promise<string | null> {
  const document: FuzzArtifactDocument = {
    schemaVersion: FUZZ_ARTIFACT_SCHEMA_VERSION,
    kind: "fuzz-finding",
    sourceRunId: String(runId),
    sourceCaseId: finding.caseId,
    slug: prepared.context.problem.slug,
    seed,
    caseIndex: finding.index,
    inputCodecVersion: prepared.context.problem.inputCodec,
    outputCodecVersion: prepared.context.problem.outputCodec,
    comparatorVersion: prepared.context.problem.comparisonPolicy,
    runtime: prepared.context.problem.runtime,
    limits: prepared.context.limits,
    generatorPath: prepared.generator,
    naivePath: prepared.naive,
    solutionPath: prepared.solution,
    originalInputBase64Url: Buffer.from(finding.encoded).toString("base64url"),
    minimizedInputBase64Url: Buffer.from(
      encodeRequestLine({
        protocolVersion: 1,
        kind: "request",
        runId: String(runId),
        caseId: finding.caseId,
        codecVersion: prepared.context.problem.inputCodec,
        messageLimitBytes: prepared.context.limits.inputBytes,
        input: minimized,
      }),
    ).toString("base64url"),
    predicate: finding.predicate,
    naive: finding.naive.envelope,
    solution: finding.solution.envelope,
    shrink,
    createdAt: d.clock.wallTimeUtc(),
  };
  let artifact;
  try {
    artifact = await writeFuzzArtifact(
      d.invocationDirectory,
      document,
      undefined,
    );
  } catch (error) {
    diagnostics.push({
      code: "artifact_write_failed",
      message: message(error),
    });
    return null;
  }
  try {
    const now = d.clock.wallTimeUtc();
    const problemId = `problem-${prepared.context.problem.slug}`;
    await d.transaction.transact(async (uow) => {
      const existing = await uow.problems.findBySlug(
        prepared.context.problem.slug,
      );
      if (existing === null)
        await uow.problems.register({
          problem_id: problemId,
          slug: prepared.context.problem.slug,
          schema_version: prepared.context.problem.schemaVersion,
          title: prepared.context.problem.title,
          created_at: now,
          updated_at: now,
        });
      const persistedProblem = existing?.problem_id ?? problemId;
      const implementationIds: Record<string, string> = {};
      for (const [role, path] of [
        ["naive", prepared.naive],
        ["solution", prepared.solution],
      ] as const) {
        const content = await readFile(
          `${prepared.context.problemRoot}/${path}`,
          "utf8",
        );
        const implementationId = `implementation-${sha256Bytes(new TextEncoder().encode(content))}`;
        implementationIds[role] = implementationId;
        await uow.implementations.register({
          implementation_id: implementationId,
          problem_id: persistedProblem,
          path,
          role,
          content_sha256: sha256Bytes(new TextEncoder().encode(content)),
          runtime: prepared.context.problem.runtime,
          created_at: now,
        });
      }
      await uow.runs.commit({
        runId,
        slug: prepared.context.problem.slug,
        state: "failed",
        status:
          finding.predicate.kind === "mismatch"
            ? "wrong_answer"
            : finding.predicate.kind === "oracle_failure"
              ? "nonzero_exit"
              : finding.solution.status,
        problemFingerprint: prepared.context.problem.slug,
        seed,
        limits: prepared.context.limits,
        inputCodecVersion: prepared.context.problem.inputCodec,
        outputCodecVersion: prepared.context.problem.outputCodec,
        comparisonPolicyVersion: prepared.context.problem.comparisonPolicy,
        inputHash: sha256Bytes(finding.encoded),
        outputHash: null,
        generation: initialGeneration(),
        wallTimeUtc: now,
        durationMs: 0,
      });
      await uow.cases.commit({
        case_id: finding.caseId,
        run_id: String(runId),
        ordinal: finding.index,
        input_sha256: sha256Bytes(finding.encoded),
        input_bytes: BigInt(finding.encoded.length),
        status:
          finding.predicate.kind === "mismatch"
            ? "wrong_answer"
            : finding.solution.status,
      });
      for (const [role, execution] of [
        ["naive", finding.naive],
        ["solution", finding.solution],
      ] as const)
        await uow.executions.commit(
          executionRow(
            id(d),
            finding.caseId,
            implementationIds[role]!,
            execution,
          ),
        );
      await uow.artifacts.commit({
        artifact_id: artifact.artifactId,
        run_id: String(runId),
        kind: "fuzz-finding",
        path: artifact.path,
        sha256: artifact.sha256,
        size_bytes: artifact.sizeBytes,
        created_at: now,
      });
    });
  } catch (error) {
    diagnostics.push({ code: "persistence_failed", message: message(error) });
  }
  return artifact.artifactId;
}
function executionRow(
  executionId: string,
  caseId: string,
  implementationId: string,
  execution: IsolatedExecution,
) {
  const e = execution.envelope;
  const stdoutTruncated: 0 | 1 = e.stdoutTruncated ? 1 : 0;
  const stderrTruncated: 0 | 1 = e.stderrTruncated ? 1 : 0;
  return {
    execution_id: executionId,
    case_id: caseId,
    implementation_id: implementationId,
    status: execution.status,
    exit_code: e.exitCode,
    signal: e.signal,
    wall_ns: toNs(e.wallTimeMs),
    cpu_ns: toNs(e.cpuTimeMs),
    peak_memory_bytes: BigInt(Math.trunc(e.memoryPeakBytes)),
    stdout_bytes: BigInt(e.stdoutBytes),
    stderr_bytes: BigInt(e.stderrBytes),
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    limit_cause: null,
    raw_json: JSON.stringify(e),
  };
}
function relativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`))
    throw new Error("asset escapes problem root");
  return value.split(sep).join("/");
}
function randomSeed(): string {
  return BigInt(`0x${randomBytes(8).toString("hex")}`).toString(10);
}
function canonicalSeed(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > (1n << 64n) - 1n)
    throw new Error("seed is not uint64");
  return BigInt(value).toString(10);
}
function caseSeed(seed: string, index: number): bigint {
  return (BigInt(seed) + BigInt(index)) & ((1n << 64n) - 1n);
}
function elapsedMs(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000;
}
function id(d: StressTestDependencies): string {
  return (d.createId ?? randomUUID)();
}
function toNs(ms: number): bigint | null {
  return Number.isFinite(ms) && ms >= 0
    ? BigInt(Math.trunc(ms * 1_000_000))
    : null;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function success(
  runId: string,
  seed: string,
  completedCases: number,
  caseLimit: number,
  durationLimitMs: number,
): StressTestOutcome {
  return {
    status: "passed",
    result: {
      runId,
      seed,
      completedCases,
      caseLimit,
      durationLimitMs,
      finding: null,
      oracleFailure: null,
    },
    diagnostics: [],
  };
}
function canceled(
  runId: string,
  seed: string,
  completedCases: number,
  caseLimit: number,
  durationLimitMs: number,
): StressTestOutcome {
  return {
    status: "canceled",
    result: {
      runId,
      seed,
      completedCases,
      caseLimit,
      durationLimitMs,
      finding: null,
      oracleFailure: null,
    },
    diagnostics: [],
  };
}
