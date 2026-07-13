/**
 * Fixed-case `test` command application facade.
 *
 * The facade coordinates configuration, static case streaming, the isolated
 * execution bundle, verdict normalization, and post-verdict persistence. It
 * depends on injected ports/factories rather than concrete CLI adapters; the
 * CLI composition root selects Node, Linux, Python, and SQLite implementations.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  type CaseId,
  type ComparisonPolicy,
  type ExecutionRequest,
  type ExecutionStatus,
  initialGeneration,
  mostSevere,
  RunLifecycle,
  type RawProcessResult,
  type RunId,
  type TerminationCause,
  toCaseId,
  toRunId,
} from "../domain/index.js";
import type { CancellationToken, Clock, RuntimeBundle } from "../execution/ports/index.js";
import {
  assertConfigurationValid,
  loadProblemConfig,
  parseEnvOverrides,
  resolveEffectiveConfig,
  type ConfigProbes,
  type EffectiveConfig,
  type EnvironmentRecord,
  type PathContext,
} from "../infrastructure/config/index.js";
import {
  decodeResponseLine,
  encodeRequestLine,
} from "../judging/codec/index.js";
import { createOutputComparator } from "../judging/comparator/index.js";
import { canonicalStringOf } from "../judging/codec/encode.js";
import type { CanonicalValue } from "../judging/value/index.js";
import type { PersistenceRecords, TransactionScope } from "../persistence/ports/index.js";
import { FixedCaseError, streamFixedCases, type FixedCase } from "./fixed-cases.js";

/** Version of mismatch artifact documents produced by this command. */
export const FIXED_MISMATCH_ARTIFACT_VERSION = 1 as const;

/** JSON-safe summary returned through the CLI result boundary. */
export interface TestCommandResult {
  readonly runId: string;
  readonly state: "completed" | "failed" | "canceled";
  readonly cases: readonly TestCaseSummary[];
  readonly caseCount: number;
  readonly passedCaseCount: number;
  readonly artifactId: string | null;
}

/** JSON-safe per-case summary; raw output remains only in persistence/artifacts. */
export interface TestCaseSummary {
  readonly caseId: string;
  readonly path: string;
  readonly status: ExecutionStatus;
  readonly durationMs: number | null;
}

/** Parsed CLI data consumed without coupling this use case to the CLI layer. */
export interface TestInvocation {
  readonly slug: string;
  readonly solution?: string;
  readonly case?: string;
  readonly unsafeLocal: boolean;
}

/** A bounded application diagnostic translated at the CLI boundary. */
export interface TestDiagnostic { readonly code: string; readonly message: string; }

/** Application outcome before the CLI maps it to its output envelope. */
export interface TestApplicationOutcome {
  readonly status: ExecutionStatus;
  readonly result: TestCommandResult | null;
  readonly diagnostics: readonly TestDiagnostic[];
}

/** Persistence rows the test use case writes through a transaction-only port. */
export interface TestPersistenceRecords extends PersistenceRecords {
  readonly problem: TestProblemRow;
  readonly implementation: TestImplementationRow;
  readonly case: TestCaseRow;
  readonly execution: TestExecutionRow;
  readonly artifact: TestArtifactRow;
  readonly replay: unknown;
}
export interface TestProblemRow { readonly problem_id: string; readonly slug: string; readonly schema_version: number; readonly title: string; readonly created_at: string; readonly updated_at: string; }
export interface TestImplementationRow { readonly implementation_id: string; readonly problem_id: string; readonly path: string; readonly role: string; readonly content_sha256: string; readonly runtime: string; readonly created_at: string; }
export interface TestCaseRow { readonly case_id: string; readonly run_id: string; readonly ordinal: number; readonly input_sha256: string; readonly input_bytes: bigint; readonly status: string; }
export interface TestExecutionRow { readonly execution_id: string; readonly case_id: string; readonly implementation_id: string; readonly status: string; readonly exit_code: number | null; readonly signal: string | null; readonly wall_ns: bigint | null; readonly cpu_ns: bigint | null; readonly peak_memory_bytes: bigint | null; readonly stdout_bytes: bigint | null; readonly stderr_bytes: bigint | null; readonly stdout_truncated: 0 | 1 | null; readonly stderr_truncated: 0 | 1 | null; readonly limit_cause: string | null; readonly raw_json: string | null; }
export interface TestArtifactRow { readonly artifact_id: string; readonly run_id: string; readonly kind: string; readonly path: string; readonly sha256: string; readonly size_bytes: bigint; readonly created_at: string; }

/** Dependencies controlled by the composition root or unit-test fakes. */
export interface TestCommandDependencies {
  readonly invocationDirectory: string;
  readonly environment: EnvironmentRecord;
  readonly cancellation: CancellationToken;
  readonly clock: Clock;
  readonly probes: ConfigProbes;
  readonly supportedRuntimes: ReadonlySet<string>;
  readonly requiredControls: readonly ("cgroup" | "rlimits" | "network" | "filesystem" | "no-new-privileges" | "drop-capabilities" | "namespaces" | "seccomp")[];
  readonly createBundle: (effective: EffectiveConfig) => RuntimeBundle;
  readonly transaction: TransactionScope<TestPersistenceRecords>;
  readonly readText: (path: string) => Promise<string>;
  readonly createId?: () => string;
  readonly sha256?: (bytes: Uint8Array) => string;
  readonly writeMismatchArtifact?: (request: MismatchArtifactWrite) => Promise<ArtifactFile>;
  /** Pure termination classifier selected by the composition root. */
  readonly classifyTermination: (raw: RawProcessResult, limits: EffectiveConfig["limits"]) => TerminationCause;
}

/** Facts needed to write one versioned mismatch artifact. */
export interface MismatchArtifactWrite {
  readonly artifactId: string;
  readonly invocationDirectory: string;
  readonly runId: string;
  readonly case: FixedCase;
  readonly actual: CanonicalValue | null;
  readonly mismatch: Readonly<{ path: string; reason: string; expected: string; actual: string }> | null;
  readonly raw: RawExecutionFact;
  readonly createdAt: string;
}

/** Artifact file metadata used by the persistence row. */
export interface ArtifactFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: bigint;
}

/** JSON-safe bounded raw sandbox facts retained with an execution/artifact. */
interface RawExecutionFact {
  readonly schemaVersion: 1;
  readonly termination: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: { readonly totalBytes: number; readonly truncated: boolean; readonly sha256: string; readonly dataBase64Url: string };
  readonly stderr: { readonly totalBytes: number; readonly truncated: boolean; readonly sha256: string; readonly dataBase64Url: string };
  readonly resources: { readonly wallTimeMs: number; readonly cpuTimeMs: number; readonly memoryPeakBytes: number; readonly oomKills: number; readonly peakProcessCount: number };
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
  readonly mismatch: Readonly<{ path: string; reason: string; expected: string; actual: string }> | null;
  readonly raw: RawExecutionFact;
  readonly durationMs: number | null;
}

/**
 * Run fixed cases for one parsed `test` invocation.
 *
 * Configuration/case-data faults return `invalid_input`; target outcomes are
 * derived strictly from raw sandbox/protocol/comparison facts. Persistence is
 * intentionally delayed until verdict formation and cannot rewrite that status.
 */
export async function executeTestCommand(
  command: TestInvocation,
  dependencies: TestCommandDependencies,
): Promise<TestApplicationOutcome> {
  const diagnostics: TestDiagnostic[] = [];
  try {
    const prepared = await prepare(command, dependencies);
    const runId = toRunId(identifier(dependencies));
    const startedAt = dependencies.clock.wallTimeUtc();
    const startedNs = dependencies.clock.monotonicNs();
    let lifecycle = RunLifecycle.queued(initialGeneration()).start().run();
    const completed: CompletedCase[] = [];

    for await (const fixedCase of streamFixedCases(prepared.selection)) {
      if (dependencies.cancellation.isCancellationRequested) {
        lifecycle = lifecycle.requestCancel();
        break;
      }
      const result = await executeOne(
        prepared.effective,
        prepared.bundle,
        prepared.problemRoot,
        fixedCase,
        runId,
        identifier(dependencies),
        dependencies,
      );
      if (result === null) {
        lifecycle = lifecycle.requestCancel();
        break;
      }
      completed.push(result);
    }

    if (dependencies.cancellation.isCancellationRequested) {
      lifecycle = lifecycle.requestCancel();
      const state = "canceled" as const;
      return Object.freeze({ status: "canceled", result: summarize(runId, state, completed, null), diagnostics: Object.freeze(diagnostics) });
    }

    const status = aggregateStatus(completed);
    lifecycle = lifecycle.settleFromResult(
      initialGeneration(),
      status === "passed" || status === "wrong_answer" ? "completed" : "failed",
    );
    const durationMs = durationSince(startedNs, dependencies.clock.monotonicNs());
    const mismatch = completed.find((item) => item.status === "wrong_answer");
    let artifact: { id: string; file: ArtifactFile } | null = null;
    if (mismatch !== undefined) {
      try {
        const artifactId = identifier(dependencies);
        artifact = {
          id: artifactId,
          file: await (dependencies.writeMismatchArtifact ?? writeMismatchArtifact)({
            artifactId,
            invocationDirectory: dependencies.invocationDirectory,
            runId,
            case: mismatch.case,
            actual: mismatch.actual,
            mismatch: mismatch.mismatch,
            raw: mismatch.raw,
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
        lifecycle.state as "completed" | "failed",
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
    return Object.freeze({ status, result: summarize(runId, lifecycle.state as "completed" | "failed", completed, artifact?.id ?? null), diagnostics: Object.freeze(diagnostics) });
  } catch (error) {
    // All errors before a target verdict are configuration/problem/case data
    // faults by this command's contract. Post-verdict artifact and SQL errors
    // are caught at their own seams above and cannot reach this conversion.
    return Object.freeze({ status: "invalid_input", result: null, diagnostics: Object.freeze([diagnostic("test_configuration_error", error)]) });
  }
}

async function prepare(command: TestInvocation, dependencies: TestCommandDependencies): Promise<{
  readonly effective: EffectiveConfig;
  readonly bundle: RuntimeBundle;
  readonly problemRoot: string;
  readonly selection: { readonly problemRoot: string; readonly casesDir: string; readonly invocationDirectory: string; readonly caseOverride?: string; readonly maxBytes: number };
}> {
  const declaredProblemRoot = resolve(dependencies.invocationDirectory, "problems", command.slug);
  const problemRoot = await realpath(declaredProblemRoot);
  const yamlPath = resolve(problemRoot, "problem.yaml");
  const problem = loadProblemConfig(await dependencies.readText(yamlPath));
  if (problem.slug !== command.slug) {
    throw new FixedCaseError(`problem.yaml slug does not match requested slug: ${problem.slug}`);
  }
  const context: PathContext = { invocationDir: dependencies.invocationDirectory, problemRoot };
  const effective = resolveEffectiveConfig({
    problem,
    env: parseEnvOverrides(dependencies.environment),
    cli: {
      unsafeLocal: command.unsafeLocal,
      ...(command.solution === undefined ? {} : { solution: command.solution }),
    },
    context,
  });
  await assertConfigurationValid({
    effective,
    probes: dependencies.probes,
    supportedRuntimes: dependencies.supportedRuntimes,
    requiredControls: dependencies.requiredControls,
  });
  const entrypoint = await confinedRealPath(effective.assets.entrypoint, problemRoot, "solution path");
  const resolved = Object.freeze({
    ...effective,
    assets: Object.freeze({ ...effective.assets, entrypoint }),
  });
  return {
    effective: resolved,
    bundle: dependencies.createBundle(resolved),
    problemRoot,
    selection: {
      problemRoot,
      casesDir: effective.assets.casesDir,
      invocationDirectory: dependencies.invocationDirectory,
      ...(command.case === undefined ? {} : { caseOverride: command.case }),
      maxBytes: effective.limits.inputBytes,
    },
  };
}

async function executeOne(
  effective: EffectiveConfig,
  bundle: RuntimeBundle,
  problemRoot: string,
  fixedCase: FixedCase,
  runId: RunId,
  executionId: string,
  dependencies: TestCommandDependencies,
): Promise<CompletedCase | null> {
  const caseId = toCaseId(identifier(dependencies));
  const requestBytes = encodeRequestLine({
    protocolVersion: 1,
    kind: "request",
    runId,
    caseId,
    codecVersion: effective.problem.inputCodec,
    messageLimitBytes: effective.limits.inputBytes,
    input: fixedCase.input,
  });
  if (requestBytes.length > effective.limits.inputBytes) {
    throw new FixedCaseError(`encoded request exceeds configured input limit for ${fixedCase.relativePath}`);
  }
  const implementation = relativeImplementation(problemRoot, effective.assets.entrypoint);
  const request: ExecutionRequest = Object.freeze({
    runId,
    caseId,
    problemFingerprint: fingerprint(effective),
    implementation: { role: "solution" as const, relativePath: implementation },
    inputBytes: requestBytes,
    inputCodecVersion: effective.problem.inputCodec,
    outputCodecVersion: effective.problem.outputCodec,
    limits: effective.limits,
    generation: initialGeneration(),
  });
  const profile = bundle.profiler.begin();
  const raw = await bundle.sandbox.run(bundle.runtime.buildInvocation(request), requestBytes, effective.limits, dependencies.cancellation);
  void profile.finish(raw);
  const rawFact = rawFactOf(raw, dependencies.sha256 ?? hashBytes);
  if (dependencies.cancellation.isCancellationRequested) {
    // A signal that arrived while the child was active wins only because no
    // verdict for this case has been formed yet; completed verdicts are never
    // overwritten by later cancellation observation.
    return null;
  }
  const termination = dependencies.classifyTermination(raw, effective.limits);
  let status: TerminationCause = termination;
  let actual: CanonicalValue | null = null;
  let mismatch: Readonly<{ path: string; reason: string; expected: string; actual: string }> | null = null;
  if (termination === "passed") {
    const response = decodeResponseLine(raw.stdout.data, {
      runId,
      caseId,
      codecVersion: effective.problem.outputCodec,
    });
    if (!response.ok || response.envelope.exception !== null || response.envelope.output === null) {
      status = "protocol_error";
    } else {
      actual = response.envelope.output;
      const compared = createOutputComparator().compare(
        fixedCase.expected,
        actual,
        comparisonPolicy(effective.problem.comparisonPolicy),
      );
      if (!compared.equal) {
        status = "wrong_answer";
        mismatch = compared.mismatch;
      }
    }
  }
  return Object.freeze({
    case: fixedCase,
    caseId,
    executionId,
    status: mostSevere(termination, status),
    inputBytes: requestBytes,
    outputBytes: raw.stdout.data.length === 0 ? null : raw.stdout.data,
    actual,
    mismatch,
    raw: rawFact,
    durationMs: finiteNonNegative(raw.resources.wallTimeMs),
  });
}

function relativeImplementation(problemRoot: string, entrypoint: string): string {
  const value = relative(problemRoot, entrypoint);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`)) {
    throw new FixedCaseError("solution path escapes the problem root");
  }
  // The Python harness runs from the problem root (bound by the composition
  // factory), so a relative script identity is mandatory and host paths never
  // cross the execution request boundary.
  return value.split(sep).join("/");
}

function comparisonPolicy(version: string): ComparisonPolicy {
  return Object.freeze({ version, equality: "semantic", normalizeWhitespace: false });
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
  return Object.freeze({
    runId,
    state,
    caseCount: cases.length,
    passedCaseCount: cases.filter((item) => item.status === "passed").length,
    artifactId,
    cases: Object.freeze(cases.map((item) => Object.freeze({
      caseId: item.caseId,
      path: item.case.relativePath,
      status: item.status,
      durationMs: item.durationMs,
    }))),
  });
}

async function persist(
  prepared: Awaited<ReturnType<typeof prepare>>,
  runId: RunId,
  state: "completed" | "failed",
  status: TerminationCause,
  startedAt: string,
  durationMs: number,
  cases: readonly CompletedCase[],
  artifact: { readonly id: string; readonly file: ArtifactFile } | null,
  dependencies: TestCommandDependencies,
): Promise<void> {
  const problemId = `problem-${prepared.effective.problem.slug}`;
  const implementationPath = relative(prepared.problemRoot, prepared.effective.assets.entrypoint).split(sep).join("/");
  const implementationContent = await dependencies.readText(prepared.effective.assets.entrypoint);
  // Source content, rather than an absolute host path, identifies a reusable
  // implementation registration and remains stable across invocation roots.
  const implementationId = `implementation-${hashText(implementationContent)}`;
  const first = cases[0];
  const run = {
    runId,
    slug: prepared.effective.problem.slug,
    state,
    status,
    problemFingerprint: fingerprint(prepared.effective),
    seed: null,
    limits: prepared.effective.limits,
    inputCodecVersion: prepared.effective.problem.inputCodec,
    outputCodecVersion: prepared.effective.problem.outputCodec,
    comparisonPolicyVersion: prepared.effective.problem.comparisonPolicy,
    inputHash: first === undefined ? hashText("") : (dependencies.sha256 ?? hashBytes)(first.inputBytes),
    outputHash: first?.outputBytes === null || first === undefined ? null : (dependencies.sha256 ?? hashBytes)(first.outputBytes),
    generation: initialGeneration(),
    wallTimeUtc: startedAt,
    durationMs,
  } as const;
  await dependencies.transaction.transact(async (uow) => {
    // Each run gets a stable problem/implementation identity only after the
    // first registration. Reusing an existing row avoids duplicate-key failure
    // while preserving the foreign-key order for run children.
    const existingProblem = await uow.problems.findBySlug(prepared.effective.problem.slug);
    const persistedProblemId = existingProblem?.problem_id ?? problemId;
    if (existingProblem === null) {
      await uow.problems.register({ problem_id: problemId, slug: prepared.effective.problem.slug, schema_version: prepared.effective.problem.schemaVersion, title: prepared.effective.problem.title, created_at: startedAt, updated_at: startedAt } satisfies TestProblemRow);
    }
    await uow.implementations.register({ implementation_id: implementationId, problem_id: persistedProblemId, path: implementationPath, role: "solution", content_sha256: hashText(implementationContent), runtime: prepared.effective.problem.runtime, created_at: startedAt } satisfies TestImplementationRow);
    await uow.runs.commit(run);
    for (let ordinal = 0; ordinal < cases.length; ordinal += 1) {
      const item = cases[ordinal]!;
      await uow.cases.commit({ case_id: item.caseId, run_id: runId, ordinal, input_sha256: (dependencies.sha256 ?? hashBytes)(item.inputBytes), input_bytes: BigInt(item.inputBytes.length), status: item.status } satisfies TestCaseRow);
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
      } satisfies TestExecutionRow);
    }
    if (artifact !== null) {
      await uow.artifacts.commit({ artifact_id: artifact.id, run_id: runId, kind: "mismatch", path: artifact.file.path, sha256: artifact.file.sha256, size_bytes: artifact.file.sizeBytes, created_at: startedAt } satisfies TestArtifactRow);
    }
  });
}

/** Write one immutable mismatch artifact before its row joins the SQL transaction. */
export async function writeMismatchArtifact(request: MismatchArtifactWrite): Promise<ArtifactFile> {
  const directory = resolve(request.invocationDirectory, ".palestra", "artifacts");
  const destination = resolve(directory, `${request.artifactId}.json`);
  const temporary = resolve(directory, `.${request.artifactId}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  const document = JSON.stringify({
    schemaVersion: FIXED_MISMATCH_ARTIFACT_VERSION,
    kind: "mismatch",
    runId: request.runId,
    case: {
      path: request.case.relativePath,
      input: JSON.parse(canonicalStringOf(request.case.input)),
      expected: JSON.parse(canonicalStringOf(request.case.expected)),
      actual: request.actual === null ? null : JSON.parse(canonicalStringOf(request.actual)),
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
    path: relative(request.invocationDirectory, destination).split(sep).join("/"),
    sha256: hashBytes(bytes),
    sizeBytes: BigInt(bytes.length),
  });
}

function rawFactOf(raw: RawProcessResult, hash: (bytes: Uint8Array) => string): RawExecutionFact {
  return Object.freeze({
    schemaVersion: 1,
    termination: raw.termination,
    exitCode: raw.exitCode,
    signal: raw.signal,
    stdout: Object.freeze({ totalBytes: raw.stdout.totalBytes, truncated: raw.stdout.truncated, sha256: hash(raw.stdout.data), dataBase64Url: Buffer.from(raw.stdout.data).toString("base64url") }),
    stderr: Object.freeze({ totalBytes: raw.stderr.totalBytes, truncated: raw.stderr.truncated, sha256: hash(raw.stderr.data), dataBase64Url: Buffer.from(raw.stderr.data).toString("base64url") }),
    resources: Object.freeze({ ...raw.resources }),
    cleanupDiagnostics: Object.freeze(raw.cleanupDiagnostics.map((value) => value.slice(0, 256))),
  });
}

async function confinedRealPath(path: string, root: string, label: string): Promise<string> {
  const resolved = await realpath(path);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new FixedCaseError(`${label} escapes the problem root`);
  }
  return resolved;
}

function fingerprint(effective: EffectiveConfig): string {
  return hashText(JSON.stringify({ problem: effective.problem, limits: effective.limits }));
}
function identifier(dependencies: TestCommandDependencies): string { return (dependencies.createId ?? randomUUID)(); }
function hashBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function hashText(text: string): string { return hashBytes(new TextEncoder().encode(text)); }
function durationSince(start: bigint, finish: bigint): number { return finiteNonNegative(Number(finish - start) / 1_000_000) ?? 0; }
function finiteNonNegative(value: number): number | null { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function millisecondsToNs(value: number): bigint | null { return Number.isFinite(value) && value >= 0 ? BigInt(Math.trunc(value * 1_000_000)) : null; }
function isLimitCause(status: TerminationCause): boolean { return ["tle_wall", "tle_cpu", "mle", "output_limit", "file_limit", "process_limit"].includes(status); }
function diagnostic(code: string, error: unknown): TestDiagnostic { return { code, message: error instanceof Error ? error.message : String(error) }; }
