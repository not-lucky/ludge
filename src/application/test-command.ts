import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { availableParallelism } from "node:os";
import {
  type CaseId,
  type ComparisonPolicy,
  type ExecutionRequest,
  type ExecutionStatus,
  initialGeneration,
  mostSevere,
  type Generation,
  type RawProcessResult,
  type RunId,
  type TerminationCause,
  toCaseId,
  toRunId,
} from "../domain/index.js";
import type { CancellationToken } from "../execution/cancellation.js";
import type { Clock } from "../execution/clock.js";
import type { Runner } from "../execution/runner.js";
import type { RunContext } from "../infrastructure/problem.js";
import {
  prepareRunContext,
  type PreparedRunContext,
  type PrepareRunOptions,
} from "./run-context.js";
import {
  decodeResponseLine,
  encodeRequestLine,
} from "../judging/codec/index.js";
import { createOutputComparator } from "../judging/comparator/index.js";
import { canonicalStringOf } from "../judging/codec/encode.js";
import type { CanonicalValue } from "../judging/value/model.js";
import type { SqliteTransactionScope } from "../persistence/sqlite/transaction-scope.js";
import type {
  ArtifactRow,
  CaseRow,
  ExecutionRow,
  ImplementationRow,
  ProblemRow,
} from "../persistence/sqlite/rows.js";
import {
  FixedCaseError,
  streamFixedCases,
  type FixedCase,
} from "./fixed-cases.js";

export const FIXED_MISMATCH_ARTIFACT_VERSION = 1 as const;

export interface TestCommandResult {
  readonly runId: string;
  readonly state: "completed" | "failed" | "canceled";
  /** Complete source-ordered case data; human mode deliberately does not dump it. */
  readonly cases: readonly TestCaseSummary[];
  readonly caseCount: number;
  readonly passedCaseCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  /** First non-passing logical case in source order, if the full run found one. */
  readonly firstFailure: (TestCaseSummary & TestFailureDetails) | null;
  readonly artifactId: string | null;
}

export interface TestCaseSummary {
  readonly caseId: string;
  readonly path: string;
  readonly status: ExecutionStatus;
  readonly durationMs: number | null;
}

/** Human-readable, JSON-safe details for the selected deterministic failure. */
export interface TestFailureDetails {
  readonly input: string;
  readonly expected: string;
  readonly actual: string | null;
  readonly error: string | null;
}

export interface TestInvocation {
  readonly slug: string;
  readonly solution?: string;
  readonly case?: string;
  /** Maximum independent fixed-case executions; omitted uses a safe default. */
  readonly jobs?: number;
  readonly unsafeLocal: boolean;
  readonly generation?: Generation;
}

export interface TestDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface TestApplicationOutcome {
  readonly status: ExecutionStatus;
  readonly result: TestCommandResult | null;
  readonly diagnostics: readonly TestDiagnostic[];
}

export interface DeferredTestExecution {
  readonly outcome: TestApplicationOutcome;
  commit(): Promise<TestApplicationOutcome>;
}

export interface TestCommandDependencies {
  readonly invocationDirectory: string;
  readonly cancellation: CancellationToken;
  readonly clock: Clock;
  readonly prepareRun?: (
    options: PrepareRunOptions,
  ) => Promise<PreparedRunContext>;
  readonly transaction: Pick<SqliteTransactionScope, "transact">;
  readonly readText: (path: string) => Promise<string>;
  readonly createId?: () => string;
  readonly sha256?: (bytes: Uint8Array) => string;
  readonly writeMismatchArtifact?: (
    request: MismatchArtifactWrite,
  ) => Promise<ArtifactFile>;
  /** Injectable bounded automatic worker count, primarily for deterministic tests. */
  readonly defaultJobs?: () => number;
  readonly classifyTermination: (
    raw: RawProcessResult,
    limits: RunContext["limits"],
  ) => TerminationCause;
}

export interface MismatchArtifactWrite {
  readonly artifactId: string;
  readonly invocationDirectory: string;
  readonly runId: string;
  readonly case: FixedCase;
  readonly actual: CanonicalValue | null;
  readonly mismatch: Readonly<{
    path: string;
    reason: string;
    expected: string;
    actual: string;
  }> | null;
  readonly raw: RawExecutionFact;
  readonly createdAt: string;
}

export interface ArtifactFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: bigint;
}

interface RawExecutionFact {
  readonly schemaVersion: 1;
  readonly termination: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: {
    readonly totalBytes: number;
    readonly truncated: boolean;
    readonly sha256: string;
    readonly dataBase64Url: string;
  };
  readonly stderr: {
    readonly totalBytes: number;
    readonly truncated: boolean;
    readonly sha256: string;
    readonly dataBase64Url: string;
  };
  readonly resources: {
    readonly wallTimeMs: number;
    readonly cpuTimeMs: number;
    readonly memoryPeakBytes: number;
    readonly oomKills: number;
    readonly peakProcessCount: number;
  };
  readonly cleanupDiagnostics: readonly string[];
}

interface CompletedCase {
  readonly case: FixedCase;
  readonly caseId: CaseId;
  readonly executionId: string;
  readonly status: TerminationCause;
  readonly inputBytes: Uint8Array;
  readonly outputBytes: Uint8Array | null;
  readonly actual: CanonicalValue | null;
  readonly mismatch: Readonly<{
    path: string;
    reason: string;
    expected: string;
    actual: string;
  }> | null;
  readonly raw: RawExecutionFact;
  readonly durationMs: number | null;
  readonly exceptionMessage?: string;
}

export async function executeTestCommand(
  command: TestInvocation,
  dependencies: TestCommandDependencies,
): Promise<TestApplicationOutcome> {
  return (await executeTestCommandDeferred(command, dependencies)).commit();
}

export async function executeTestCommandDeferred(
  command: TestInvocation,
  dependencies: TestCommandDependencies,
): Promise<DeferredTestExecution> {
  const diagnostics: TestDiagnostic[] = [];
  try {
    const prepared = await prepare(command, dependencies);
    const runId = toRunId(identifier(dependencies));
    const startedAt = dependencies.clock.wallTimeUtc();
    const startedNs = dependencies.clock.monotonicNs();
    const generation = command.generation ?? initialGeneration();
    const fixedCases: FixedCase[] = [];
    for await (const fixedCase of streamFixedCases(prepared.selection)) {
      if (dependencies.cancellation.isCancellationRequested) break;
      fixedCases.push(fixedCase);
    }
    const completed = await executeFixedCases(
      prepared,
      fixedCases,
      runId,
      generation,
      command.jobs ?? automaticJobs(dependencies),
      dependencies,
    );

    if (dependencies.cancellation.isCancellationRequested) {
      const state = "canceled" as const;
      return deferred(
        Object.freeze({
          status: "canceled",
          result: summarize(runId, state, completed, null),
          diagnostics: Object.freeze(diagnostics),
        }),
      );
    }

    const status = aggregateStatus(completed);
    appendSandboxDiagnostics(completed, diagnostics);
    const state =
      status === "passed" || status === "wrong_answer" ? "completed" : "failed";
    const durationMs = durationSince(
      startedNs,
      dependencies.clock.monotonicNs(),
    );
    const firstFailure = completed.find((item) => item.status !== "passed");
    const uncommitted = Object.freeze({
      status,
      result: summarize(runId, state, completed, null),
      diagnostics: Object.freeze([...diagnostics]),
    });
    let committed: Promise<TestApplicationOutcome> | undefined;
    return Object.freeze({
      outcome: uncommitted,
      commit: (): Promise<TestApplicationOutcome> => {
        committed ??= commitDeferredTest({
          prepared,
          runId,
          generation,
          state,
          status,
          startedAt,
          durationMs,
          completed,
          firstFailure,
          dependencies,
          diagnostics,
        });
        return committed;
      },
    });
  } catch (error) {
    return deferred(
      Object.freeze({
        status: "invalid_input",
        result: null,
        diagnostics: Object.freeze([
          diagnostic("test_configuration_error", error),
        ]),
      }),
    );
  }
}

interface DeferredCommitInput {
  readonly prepared: Awaited<ReturnType<typeof prepare>>;
  readonly runId: RunId;
  readonly generation: Generation;
  readonly state: "completed" | "failed";
  readonly status: TerminationCause;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly completed: readonly CompletedCase[];
  readonly firstFailure: CompletedCase | undefined;
  readonly dependencies: TestCommandDependencies;
  readonly diagnostics: TestDiagnostic[];
}

function deferred(outcome: TestApplicationOutcome): DeferredTestExecution {
  return Object.freeze({ outcome, commit: async () => outcome });
}

async function commitDeferredTest(
  input: DeferredCommitInput,
): Promise<TestApplicationOutcome> {
  const {
    prepared,
    runId,
    generation,
    state,
    status,
    startedAt,
    durationMs,
    completed,
    firstFailure,
    dependencies,
  } = input;
  const diagnostics = [...input.diagnostics];
  let artifact: { id: string; file: ArtifactFile } | null = null;
  if (firstFailure !== undefined) {
    try {
      const artifactId = identifier(dependencies);
      artifact = {
        id: artifactId,
        file: await (
          dependencies.writeMismatchArtifact ?? writeMismatchArtifact
        )({
          artifactId,
          invocationDirectory: dependencies.invocationDirectory,
          runId,
          case: firstFailure.case,
          actual: firstFailure.actual,
          mismatch: firstFailure.mismatch,
          raw: firstFailure.raw,
          createdAt: dependencies.clock.wallTimeUtc(),
        }),
      };
    } catch (error) {
      diagnostics.push(diagnostic("artifact_write_failed", error));
    }
  }
  try {
    await persist(
      prepared,
      runId,
      generation,
      state,
      status,
      startedAt,
      durationMs,
      completed,
      artifact,
      dependencies,
    );
  } catch (error) {
    diagnostics.push(diagnostic("persistence_failed", error));
  }
  return Object.freeze({
    status,
    result: summarize(runId, state, completed, artifact?.id ?? null),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function prepare(
  command: TestInvocation,
  dependencies: TestCommandDependencies,
): Promise<{
  readonly context: RunContext;
  readonly runner: Runner;
  readonly problemRoot: string;
  readonly selection: {
    readonly problemRoot: string;
    readonly casesDir: string;
    readonly invocationDirectory: string;
    readonly problem: RunContext["problem"];
    readonly caseOverride?: string;
    readonly maxBytes: number;
  };
}> {
  const prepared = await (dependencies.prepareRun ?? prepareRunContext)({
    invocationDirectory: dependencies.invocationDirectory,
    slug: command.slug,
    unsafeLocal: command.unsafeLocal,
    ...(command.solution === undefined ? {} : { solution: command.solution }),
  });
  return {
    ...prepared,
    problemRoot: prepared.context.problemRoot,
    selection: {
      problemRoot: prepared.context.problemRoot,
      casesDir: prepared.context.assets.casesDir,
      invocationDirectory: dependencies.invocationDirectory,
      problem: prepared.context.problem,
      ...(command.case === undefined ? {} : { caseOverride: command.case }),
      maxBytes: prepared.context.limits.inputBytes,
    },
  };
}

/**
 * Execute all selected cases without failure short-circuiting. Workers claim
 * source ordinals synchronously, so a later-finishing case can never alter
 * result, persistence, artifact, or human-failure ordering. Cancellation
 * prevents new claims and then waits for already-started runner calls to drain.
 */
async function executeFixedCases(
  prepared: Awaited<ReturnType<typeof prepare>>,
  fixedCases: readonly FixedCase[],
  runId: RunId,
  generation: Generation,
  jobs: number,
  dependencies: TestCommandDependencies,
): Promise<CompletedCase[]> {
  if (!Number.isSafeInteger(jobs) || jobs <= 0) {
    throw new FixedCaseError("--jobs must be a positive safe integer");
  }
  const workerCount = Math.min(jobs, fixedCases.length);
  if (workerCount === 0) return [];
  const completed: Array<CompletedCase | undefined> = Array(fixedCases.length);
  let nextOrdinal = 0;
  const worker = async (): Promise<void> => {
    while (!dependencies.cancellation.isCancellationRequested) {
      const ordinal = nextOrdinal;
      if (ordinal >= fixedCases.length) return;
      nextOrdinal += 1;
      const result = await executeOne(
        prepared.context,
        prepared.runner,
        prepared.problemRoot,
        fixedCases[ordinal]!,
        runId,
        identifier(dependencies),
        generation,
        dependencies,
      );
      if (result !== null) completed[ordinal] = result;
      if (
        result === null ||
        dependencies.cancellation.isCancellationRequested
      ) {
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return completed.filter((item): item is CompletedCase => item !== undefined);
}

/** Conservative automatic cap avoids opening an unbounded number of sandboxes. */
function automaticJobs(dependencies: TestCommandDependencies): number {
  const jobs = dependencies.defaultJobs?.() ?? availableParallelism();
  if (!Number.isSafeInteger(jobs) || jobs <= 0) return 1;
  return Math.min(jobs, 16);
}

async function executeOne(
  context: RunContext,
  runner: Runner,
  problemRoot: string,
  fixedCase: FixedCase,
  runId: RunId,
  executionId: string,
  generation: Generation,
  dependencies: TestCommandDependencies,
): Promise<CompletedCase | null> {
  const caseId = toCaseId(identifier(dependencies));
  const requestBytes = encodeRequestLine({
    protocolVersion: 1,
    kind: "request",
    runId,
    caseId,
    codecVersion: context.problem.inputCodec,
    messageLimitBytes: context.limits.inputBytes,
    input: fixedCase.input,
  });
  if (requestBytes.length > context.limits.inputBytes) {
    throw new FixedCaseError(
      `encoded request exceeds configured input limit for ${fixedCase.relativePath}`,
    );
  }
  const implementation = relativeImplementation(
    problemRoot,
    context.assets.entrypoint,
  );
  const request: ExecutionRequest = Object.freeze({
    runId,
    caseId,
    problemFingerprint: fingerprint(context),
    implementation: { role: "solution" as const, relativePath: implementation },
    inputBytes: requestBytes,
    inputCodecVersion: context.problem.inputCodec,
    outputCodecVersion: context.problem.outputCodec,
    limits: context.limits,
    generation,
  });
  const profile = runner.beginProfile();
  const raw = await runner.run(
    request,
    requestBytes,
    dependencies.cancellation,
  );
  void profile.finish(raw);
  const rawFact = rawFactOf(raw, dependencies.sha256 ?? hashBytes);
  if (dependencies.cancellation.isCancellationRequested) {
    return null;
  }
  const termination = dependencies.classifyTermination(raw, context.limits);
  let status: TerminationCause = termination;
  let actual: CanonicalValue | null = null;
  let mismatch: Readonly<{
    path: string;
    reason: string;
    expected: string;
    actual: string;
  }> | null = null;
  let exceptionMessage: string | undefined;
  if (termination === "passed") {
    const response = decodeResponseLine(raw.stdout.data, {
      runId,
      caseId,
      codecVersion: context.problem.outputCodec,
    });
    if (!response.ok) {
      status = "protocol_error";
    } else if (response.envelope.exception !== null) {
      status = "protocol_error";
      const exc = response.envelope.exception;
      if (exc.tag === "exception") {
        exceptionMessage = `Target exception: ${exc.type}: ${exc.message}`;
      }
    } else if (response.envelope.output === null) {
      status = "protocol_error";
    } else {
      actual = response.envelope.output;
      const compared = createOutputComparator().compare(
        fixedCase.expected,
        actual,
        comparisonPolicy(context.problem.comparisonPolicy),
      );
      if (!compared.equal) {
        status = "wrong_answer";
        mismatch = compared.mismatch;
      }
    }
  }
  const finalStatus = mostSevere(termination, status);
  if (
    finalStatus === "protocol_error" &&
    !exceptionMessage &&
    raw.stderr.data.length > 0
  ) {
    const text = new TextDecoder().decode(raw.stderr.data).trim();
    if (text) exceptionMessage = text;
  }
  return Object.freeze({
    case: fixedCase,
    caseId,
    executionId,
    status: finalStatus,
    inputBytes: requestBytes,
    outputBytes: raw.stdout.data.length === 0 ? null : raw.stdout.data,
    actual,
    mismatch,
    raw: rawFact,
    durationMs: finiteNonNegative(raw.resources.wallTimeMs),
    ...(exceptionMessage === undefined ? {} : { exceptionMessage }),
  });
}

function relativeImplementation(
  problemRoot: string,
  entrypoint: string,
): string {
  const value = relative(problemRoot, entrypoint);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`)) {
    throw new FixedCaseError("solution path escapes the problem root");
  }
  return value.split(sep).join("/");
}

function comparisonPolicy(version: string): ComparisonPolicy {
  return Object.freeze({
    version,
    equality: "semantic",
    normalizeWhitespace: false,
  });
}

/** Surface bounded sandbox setup or protocol failure reasons at the command boundary. */
function appendSandboxDiagnostics(
  cases: readonly CompletedCase[],
  diagnostics: TestDiagnostic[],
): void {
  const failure = cases.find((item) => item.status === "spawn_error");
  const detail = failure?.raw.cleanupDiagnostics[0];
  if (detail !== undefined) {
    diagnostics.push({
      code: "sandbox_setup_failed",
      message: detail.length <= 1_000 ? detail : `${detail.slice(0, 997)}…`,
    });
  }
  const protocolFailure = cases.find(
    (item) => item.status === "protocol_error" && item.exceptionMessage,
  );
  if (protocolFailure?.exceptionMessage) {
    const msg = protocolFailure.exceptionMessage;
    diagnostics.push({
      code: "protocol_error",
      message: msg.length <= 1_000 ? msg : `${msg.slice(0, 997)}…`,
    });
  }
}

function aggregateStatus(cases: readonly CompletedCase[]): TerminationCause {
  if (cases.length === 0) return "protocol_error";
  const [first, ...rest] = cases.map((item) => item.status);
  return mostSevere(first!, ...rest);
}

function summarize(
  runId: RunId,
  state: "completed" | "failed" | "canceled",
  cases: readonly CompletedCase[],
  artifactId: string | null,
): TestCommandResult {
  const summaries = cases.map((item) => caseSummary(item));
  const statusCounts: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  for (const item of summaries) {
    statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
  }
  return Object.freeze({
    runId,
    state,
    caseCount: cases.length,
    passedCaseCount: summaries.filter((item) => item.status === "passed")
      .length,
    statusCounts: Object.freeze(statusCounts),
    firstFailure: firstFailureSummary(cases) ?? null,
    artifactId,
    cases: Object.freeze(summaries),
  });
}

async function persist(
  prepared: Awaited<ReturnType<typeof prepare>>,
  runId: RunId,
  generation: Generation,
  state: "completed" | "failed",
  status: TerminationCause,
  startedAt: string,
  durationMs: number,
  cases: readonly CompletedCase[],
  artifact: { readonly id: string; readonly file: ArtifactFile } | null,
  dependencies: TestCommandDependencies,
): Promise<void> {
  const problemId = `problem-${prepared.context.problem.slug}`;
  const implementationPath = relative(
    prepared.problemRoot,
    prepared.context.assets.entrypoint,
  )
    .split(sep)
    .join("/");
  const implementationContent = await dependencies.readText(
    prepared.context.assets.entrypoint,
  );
  const implementationId = `implementation-${hashText(implementationContent)}`;
  const first = cases[0];
  const run = {
    runId,
    slug: prepared.context.problem.slug,
    state,
    status,
    problemFingerprint: fingerprint(prepared.context),
    seed: null,
    limits: prepared.context.limits,
    inputCodecVersion: prepared.context.problem.inputCodec,
    outputCodecVersion: prepared.context.problem.outputCodec,
    comparisonPolicyVersion: prepared.context.problem.comparisonPolicy,
    inputHash:
      first === undefined
        ? hashText("")
        : (dependencies.sha256 ?? hashBytes)(first.inputBytes),
    outputHash:
      first?.outputBytes === null || first === undefined
        ? null
        : (dependencies.sha256 ?? hashBytes)(first.outputBytes),
    generation,
    wallTimeUtc: startedAt,
    durationMs,
  } as const;
  await dependencies.transaction.transact(async (uow) => {
    const existingProblem = await uow.problems.findBySlug(
      prepared.context.problem.slug,
    );
    const persistedProblemId = existingProblem?.problem_id ?? problemId;
    if (existingProblem === null) {
      await uow.problems.register({
        problem_id: problemId,
        slug: prepared.context.problem.slug,
        schema_version: prepared.context.problem.schemaVersion,
        title: prepared.context.problem.title,
        created_at: startedAt,
        updated_at: startedAt,
      } satisfies ProblemRow);
    }
    await uow.implementations.register({
      implementation_id: implementationId,
      problem_id: persistedProblemId,
      path: implementationPath,
      role: "solution",
      content_sha256: hashText(implementationContent),
      runtime: prepared.context.problem.runtime,
      created_at: startedAt,
    } satisfies ImplementationRow);
    await uow.runs.commit(run);
    for (let ordinal = 0; ordinal < cases.length; ordinal += 1) {
      const item = cases[ordinal]!;
      await uow.cases.commit({
        case_id: item.caseId,
        run_id: runId,
        ordinal,
        input_sha256: (dependencies.sha256 ?? hashBytes)(item.inputBytes),
        input_bytes: BigInt(item.inputBytes.length),
        status: item.status,
      } satisfies CaseRow);
      await uow.executions.commit({
        execution_id: item.executionId,
        case_id: item.caseId,
        implementation_id: implementationId,
        status: item.status,
        exit_code: item.raw.exitCode,
        signal: item.raw.signal,
        wall_ns: millisecondsToNs(item.raw.resources.wallTimeMs),
        cpu_ns: millisecondsToNs(item.raw.resources.cpuTimeMs),
        peak_memory_bytes: BigInt(item.raw.resources.memoryPeakBytes),
        stdout_bytes: BigInt(item.raw.stdout.totalBytes),
        stderr_bytes: BigInt(item.raw.stderr.totalBytes),
        stdout_truncated: item.raw.stdout.truncated ? 1 : 0,
        stderr_truncated: item.raw.stderr.truncated ? 1 : 0,
        limit_cause: isLimitCause(item.status) ? item.status : null,
        raw_json: JSON.stringify(item.raw),
      } satisfies ExecutionRow);
    }
    if (artifact !== null) {
      await uow.artifacts.commit({
        artifact_id: artifact.id,
        run_id: runId,
        kind: "mismatch",
        path: artifact.file.path,
        sha256: artifact.file.sha256,
        size_bytes: artifact.file.sizeBytes,
        created_at: startedAt,
      } satisfies ArtifactRow);
    }
  });
}

export async function writeMismatchArtifact(
  request: MismatchArtifactWrite,
): Promise<ArtifactFile> {
  const directory = resolve(
    request.invocationDirectory,
    ".palestra",
    "artifacts",
  );
  const destination = resolve(directory, `${request.artifactId}.json`);
  const temporary = resolve(
    directory,
    `.${request.artifactId}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  const document = JSON.stringify({
    schemaVersion: FIXED_MISMATCH_ARTIFACT_VERSION,
    kind: "mismatch",
    runId: request.runId,
    case: {
      path: request.case.relativePath,
      input: JSON.parse(canonicalStringOf(request.case.input)),
      expected: JSON.parse(canonicalStringOf(request.case.expected)),
      actual:
        request.actual === null
          ? null
          : JSON.parse(canonicalStringOf(request.actual)),
    },
    mismatch: request.mismatch,
    rawExecution: request.raw,
    createdAt: request.createdAt,
  });
  const bytes = new TextEncoder().encode(document);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    path: relative(request.invocationDirectory, destination)
      .split(sep)
      .join("/"),
    sha256: hashBytes(bytes),
    sizeBytes: BigInt(bytes.length),
  });
}

function rawFactOf(
  raw: RawProcessResult,
  hash: (bytes: Uint8Array) => string,
): RawExecutionFact {
  return Object.freeze({
    schemaVersion: 1,
    termination: raw.termination,
    exitCode: raw.exitCode,
    signal: raw.signal,
    stdout: Object.freeze({
      totalBytes: raw.stdout.totalBytes,
      truncated: raw.stdout.truncated,
      sha256: hash(raw.stdout.data),
      dataBase64Url: Buffer.from(raw.stdout.data).toString("base64url"),
    }),
    stderr: Object.freeze({
      totalBytes: raw.stderr.totalBytes,
      truncated: raw.stderr.truncated,
      sha256: hash(raw.stderr.data),
      dataBase64Url: Buffer.from(raw.stderr.data).toString("base64url"),
    }),
    resources: Object.freeze({ ...raw.resources }),
    cleanupDiagnostics: Object.freeze(
      raw.cleanupDiagnostics.map((value) => value.slice(0, 256)),
    ),
  });
}

function fingerprint(context: RunContext): string {
  return hashText(
    JSON.stringify({ problem: context.problem, limits: context.limits }),
  );
}
function identifier(dependencies: TestCommandDependencies): string {
  return (dependencies.createId ?? randomUUID)();
}
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashText(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}
function durationSince(start: bigint, finish: bigint): number {
  return finiteNonNegative(Number(finish - start) / 1_000_000) ?? 0;
}
function finiteNonNegative(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function millisecondsToNs(value: number): bigint | null {
  return Number.isFinite(value) && value >= 0
    ? BigInt(Math.trunc(value * 1_000_000))
    : null;
}
function caseSummary(item: CompletedCase): TestCaseSummary {
  return Object.freeze({
    caseId: item.caseId,
    path: item.case.relativePath,
    status: item.status,
    durationMs: item.durationMs,
  });
}

function firstFailureSummary(
  cases: readonly CompletedCase[],
): (TestCaseSummary & TestFailureDetails) | undefined {
  const item = cases.find((caseResult) => caseResult.status !== "passed");
  if (item === undefined) return undefined;
  return Object.freeze({
    ...caseSummary(item),
    input: renderCaseValue(item.case.input),
    expected: renderCaseValue(item.case.expected),
    actual: item.actual === null ? null : renderCaseValue(item.actual),
    error: failureError(item),
  });
}

/** Render the LeetCode-facing value rather than exposing tagged wire values. */
function renderCaseValue(value: CanonicalValue): string {
  return JSON.stringify(toDisplayValue(value));
}

function toDisplayValue(value: CanonicalValue): unknown {
  switch (value.tag) {
    case "null":
      return null;
    case "bool":
    case "str":
      return value.value;
    case "int":
      return Number.isSafeInteger(Number(value.value))
        ? Number(value.value)
        : value.value.toString();
    case "float":
      return value.negativeZero ? -0 : Number(value.value);
    case "list":
    case "tuple":
      return value.items.map(toDisplayValue);
    case "ListNode":
      return value.values.map(toDisplayValue);
    case "TreeNode":
      return value.values.map((item) =>
        item === null ? null : toDisplayValue(item),
      );
    default:
      return canonicalStringOf(value);
  }
}

function failureError(item: CompletedCase): string | null {
  if (item.exceptionMessage !== undefined) return item.exceptionMessage;
  if (item.status === "wrong_answer") return null;
  if (item.mismatch !== null) return item.mismatch.reason;
  const stderr = new TextDecoder()
    .decode(Buffer.from(item.raw.stderr.dataBase64Url, "base64url"))
    .trim();
  if (stderr) return stderr;
  return `Execution failed with status ${item.status}`;
}

function isLimitCause(status: TerminationCause): boolean {
  return [
    "tle_wall",
    "tle_cpu",
    "mle",
    "output_limit",
    "file_limit",
    "process_limit",
  ].includes(status);
}
function diagnostic(code: string, error: unknown): TestDiagnostic {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}
