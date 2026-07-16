import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
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
import { canonicalStringOf } from "../judging/codec/encode.js";
import type { SqliteTransactionScope } from "../persistence/sqlite/transaction-scope.js";
import type {
  BenchmarkAggregateRow,
  BenchmarkSampleRow,
} from "../persistence/sqlite/rows.js";
import { streamFixedCases, type FixedCase } from "./fixed-cases.js";
import {
  executeCase,
  sha256Bytes,
  type IsolatedExecution,
} from "./execute-case.js";
import {
  collectBenchmarkEnvironment,
  fingerprintBenchmarkEnvironment,
} from "../benchmark/environment.js";
import {
  formatUint64Seed,
  orderImplementations,
  parseUint64Seed,
} from "../benchmark/ordering.js";
import {
  calculateBenchmarkStatistics,
  calculatePairedBaselineDelta,
  labelIqrOutliers,
  type BenchmarkStatistics,
  type ExactRatio,
  type IqrOutlierLabel,
} from "../benchmark/statistics.js";

export const BENCHMARK_METHODOLOGY_VERSION = "benchmark-e2e-v1";
export const DEFAULT_BENCHMARK_WARMUPS = 3;
export const DEFAULT_BENCHMARK_SAMPLES = 30;
export const BENCHMARK_CPU_WEIGHT = 100;

export interface BenchmarkInvocation {
  readonly slug: string;
  readonly solutions: readonly string[];
  readonly cases?: string;
  readonly warmup?: number;
  readonly samples?: number;
  readonly unsafeLocal: boolean;
}

export interface BenchmarkSummaryStatistics {
  readonly count: number;
  readonly validCount: number;
  readonly failedCount: number;
  readonly minNs: string | null;
  readonly medianNs: string | null;
  readonly p90Ns: string | null;
  readonly p95Ns: string | null;
  readonly p99Ns: string | null;
  readonly maxNs: string | null;
  readonly meanNs: string | null;
  readonly stddevNs: string | null;
  readonly memoryMedianBytes: string | null;
  readonly memoryP95Bytes: string | null;
  readonly memoryMaxBytes: string | null;
}

export interface BenchmarkImplementationResult {
  readonly implementationId: string;
  readonly path: string;
  readonly sourceSha256: string;
  readonly baseline: boolean;
  readonly statistics: BenchmarkSummaryStatistics;
  readonly pairedMedianDeltaNs: string | null;
  readonly relativeDelta: {
    readonly numerator: string;
    readonly denominator: string;
  } | null;
}

export interface BenchmarkCommandResult {
  readonly runId: string;
  readonly state: "completed" | "failed" | "canceled";
  readonly warmups: number;
  readonly sampleCount: number;
  readonly orderSeed: string;
  readonly methodologyVersion: string;
  readonly benchmarkPlanSha256: string;
  readonly comparability: "comparable" | "non_comparable";
  readonly comparabilityReason: string | null;
  readonly implementations: readonly BenchmarkImplementationResult[];
}

export interface BenchmarkOutcome {
  readonly status: ExecutionStatus;
  readonly result: BenchmarkCommandResult | null;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

export interface BenchmarkDependencies {
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
  readonly readText?: (path: string) => Promise<string>;
  readonly createId?: () => string;
  readonly chooseOrderSeed?: () => string;
  readonly runtimeMetadata: () => Readonly<{
    pythonVersion: string;
    uvVersion: string;
    sandboxMode: string;
    databaseMode: string;
  }>;
  readonly telemetry?: (
    event: "benchmark.sample",
    data: Readonly<Record<string, string | number | boolean | null>>,
  ) => void;
}

interface PreparedImplementation {
  readonly index: number;
  readonly path: string;
  readonly relativePath: string;
  readonly sourceSha256: string;
  readonly implementationId: string;
}
interface Prepared {
  readonly context: RunContext;
  readonly runner: Runner;
  readonly cases: readonly FixedCase[];
  readonly implementations: readonly PreparedImplementation[];
  readonly planSha256: string;
}
interface CompletedSample {
  readonly sampleId: string;
  readonly caseId: string;
  readonly caseOrdinal: number;
  readonly implementation: PreparedImplementation;
  readonly ordinal: number;
  readonly warmup: boolean;
  readonly status: TerminationCause;
  readonly valid: boolean;
  readonly setupNs: bigint | null;
  readonly targetNs: bigint | null;
  readonly totalNs: bigint;
  readonly peakMemoryBytes: bigint | null;
  readonly inputHash: string;
  readonly inputBytes: number;
  readonly raw: IsolatedExecution["envelope"];
  readonly cpuWeightApplied: boolean | null;
  outlier: IqrOutlierLabel;
}

export async function executeBenchmarkCommand(
  command: BenchmarkInvocation,
  dependencies: BenchmarkDependencies,
): Promise<BenchmarkOutcome> {
  const diagnostics: { code: string; message: string }[] = [];
  try {
    if (command.solutions.length < 2)
      throw new Error(
        "benchmark requires at least two explicit solution paths",
      );
    const prepared = await prepare(command, dependencies);
    const runId = toRunId(identifier(dependencies));
    const warmups = command.warmup ?? DEFAULT_BENCHMARK_WARMUPS;
    const sampleCount = command.samples ?? DEFAULT_BENCHMARK_SAMPLES;
    const orderSeed = canonicalSeed(
      dependencies.chooseOrderSeed?.() ?? randomOrderSeed(),
    );
    const startedAt = dependencies.clock.wallTimeUtc();
    const startedNs = dependencies.clock.monotonicNs();

    const validation = await validateEquivalentOutputs(
      prepared,
      runId,
      dependencies,
    );
    if (dependencies.cancellation.isCancellationRequested)
      return canceled(
        runId,
        warmups,
        sampleCount,
        orderSeed,
        prepared.planSha256,
      );
    if (validation !== null) {
      return Object.freeze({
        status: validation.status,
        result: null,
        diagnostics: Object.freeze([validation]),
      });
    }

    const samples = await measure(
      prepared,
      runId,
      warmups,
      sampleCount,
      orderSeed,
      dependencies,
    );
    if (dependencies.cancellation.isCancellationRequested)
      return canceled(
        runId,
        warmups,
        sampleCount,
        orderSeed,
        prepared.planSha256,
      );
    labelOutliers(samples);
    const comparability = determineComparability(samples);
    const benchmarkStatus = aggregateBenchmarkStatus(samples);
    const state = benchmarkStatus === "passed" ? "completed" : "failed";
    const finishedAt = dependencies.clock.wallTimeUtc();
    const result = resultOf(
      runId,
      state,
      prepared,
      samples,
      warmups,
      sampleCount,
      orderSeed,
      comparability,
    );
    try {
      await persist(
        prepared,
        runId,
        state,
        benchmarkStatus,
        startedAt,
        finishedAt,
        startedNs,
        dependencies.clock.monotonicNs(),
        warmups,
        sampleCount,
        orderSeed,
        samples,
        comparability,
        dependencies,
      );
    } catch (error) {
      diagnostics.push({ code: "persistence_failed", message: message(error) });
    }
    return Object.freeze({
      status: benchmarkStatus,
      result,
      diagnostics: Object.freeze(diagnostics),
    });
  } catch (error) {
    return Object.freeze({
      status: "invalid_input",
      result: null,
      diagnostics: Object.freeze([
        { code: "benchmark_configuration_error", message: message(error) },
      ]),
    });
  }
}

async function prepare(
  command: BenchmarkInvocation,
  d: BenchmarkDependencies,
): Promise<Prepared> {
  const prepared = await (d.prepareRun ?? prepareRunContext)({
    invocationDirectory: d.invocationDirectory,
    slug: command.slug,
    unsafeLocal: command.unsafeLocal,
    benchmarkCpuWeight: BENCHMARK_CPU_WEIGHT,
  });
  const { context } = prepared;
  const root = context.problemRoot;
  const cases: FixedCase[] = [];
  for await (const item of streamFixedCases({
    problemRoot: root,
    casesDir: context.assets.casesDir,
    invocationDirectory: d.invocationDirectory,
    problem: context.problem,
    ...(command.cases === undefined ? {} : { caseOverride: command.cases }),
    maxBytes: context.limits.inputBytes,
  }))
    cases.push(item);
  if (cases.length === 0)
    throw new Error("benchmark requires at least one selected case");
  const implementations = await Promise.all(
    command.solutions.map(async (candidate, index) => {
      const path = await realpath(resolveWithinRoot(root, candidate));
      const relativePath = relativeWithinRoot(root, path);
      const sourceSha256 = sha256Bytes(
        new TextEncoder().encode(await (d.readText ?? readText)(path)),
      );
      return Object.freeze({
        index,
        path,
        relativePath,
        sourceSha256,
        implementationId: `implementation-${sha256Text(`${relativePath}\u0000${sourceSha256}`)}`,
      });
    }),
  );
  if (
    new Set(implementations.map((item) => item.relativePath)).size !==
    implementations.length
  )
    throw new Error("--solutions must not contain duplicate paths");
  const planSha256 = sha256Text(
    JSON.stringify(
      implementations.map(({ relativePath, sourceSha256 }) => ({
        relativePath,
        sourceSha256,
      })),
    ),
  );
  return Object.freeze({
    context,
    runner: prepared.runner,
    cases: Object.freeze(cases),
    implementations: Object.freeze(implementations),
    planSha256,
  });
}

async function validateEquivalentOutputs(
  prepared: Prepared,
  runId: RunId,
  d: BenchmarkDependencies,
): Promise<{ code: string; message: string; status: TerminationCause } | null> {
  const runner = prepared.runner;
  for (
    let caseOrdinal = 0;
    caseOrdinal < prepared.cases.length;
    caseOrdinal += 1
  ) {
    const item = prepared.cases[caseOrdinal]!;
    for (const implementation of prepared.implementations) {
      const execution = await executeOne(
        prepared.context,
        runner,
        runId,
        toCaseId(identifier(d)),
        implementation,
        item.input,
        d,
      );
      if (execution.status !== "passed") {
        return {
          code: "benchmark_validation_failed",
          message: `${implementation.relativePath} failed ${item.relativePath}; no measurement was performed`,
          status: execution.status,
        };
      }
      if (execution.exception !== null || execution.output === null) {
        return {
          code: "benchmark_validation_failed",
          message: `${implementation.relativePath} produced an invalid response for ${item.relativePath}; no measurement was performed`,
          status: "protocol_error",
        };
      }
      if (
        !sameOutput(
          prepared.context.problem.comparisonPolicy,
          item.expected,
          execution.output,
        )
      ) {
        return {
          code: "benchmark_validation_failed",
          message: `${implementation.relativePath} does not match ${item.relativePath}; no measurement was performed`,
          status: "wrong_answer",
        };
      }
    }
  }
  return null;
}

async function measure(
  prepared: Prepared,
  runId: RunId,
  warmups: number,
  sampleCount: number,
  orderSeed: string,
  d: BenchmarkDependencies,
): Promise<CompletedSample[]> {
  const samples: CompletedSample[] = [];
  const seed = parseUint64Seed(orderSeed);
  const total = warmups + sampleCount;
  for (
    let caseOrdinal = 0;
    caseOrdinal < prepared.cases.length;
    caseOrdinal += 1
  ) {
    const item = prepared.cases[caseOrdinal]!;
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      if (d.cancellation.isCancellationRequested) return samples;
      const warmup = ordinal < warmups;
      for (const implementation of orderImplementations(
        prepared.implementations,
        seed,
        caseOrdinal,
        ordinal,
      )) {
        const totalStarted = d.clock.monotonicNs();
        const runner = prepared.runner;
        const caseId = toCaseId(identifier(d));
        const execution = await executeOne(
          prepared.context,
          runner,
          runId,
          caseId,
          implementation,
          item.input,
          d,
        );
        const totalNs = d.clock.monotonicNs() - totalStarted;
        const raw = execution.raw;
        const valid = isValidExecution(execution) && execution.output !== null;
        const sample: CompletedSample = {
          sampleId: identifier(d),
          caseId: String(caseId),
          caseOrdinal,
          implementation,
          ordinal,
          warmup,
          status: execution.status,
          valid,
          setupNs: raw.phases?.setupNs ?? null,
          targetNs: raw.phases?.targetNs ?? null,
          totalNs,
          peakMemoryBytes:
            Number.isFinite(raw.resources.memoryPeakBytes) &&
            raw.resources.memoryPeakBytes >= 0
              ? BigInt(Math.trunc(raw.resources.memoryPeakBytes))
              : null,
          inputHash: sha256Text(canonicalStringOf(item.input)),
          inputBytes: new TextEncoder().encode(canonicalStringOf(item.input))
            .length,
          raw: execution.envelope,
          cpuWeightApplied: raw.resources.cpuWeightApplied ?? null,
          outlier: "none",
        };
        samples.push(sample);
        d.telemetry?.("benchmark.sample", {
          caseOrdinal,
          ordinal,
          warmup,
          status: sample.status,
          implementation: implementation.relativePath,
          totalNs: totalNs.toString(),
        });
      }
    }
  }
  return samples;
}

async function executeOne(
  context: RunContext,
  runner: Runner,
  runId: RunId,
  caseId: ReturnType<typeof toCaseId>,
  implementation: PreparedImplementation,
  input: CanonicalValue,
  d: BenchmarkDependencies,
): Promise<IsolatedExecution> {
  return executeCase(
    context,
    {
      runId,
      caseId,
      problemFingerprint: context.problem.slug,
      implementation: {
        role: "solution",
        relativePath: implementation.relativePath,
      },
      inputCodecVersion: context.problem.inputCodec,
      outputCodecVersion: context.problem.outputCodec,
      limits: context.limits,
      generation: initialGeneration(),
    },
    input,
    {
      runner,
      cancellation: d.cancellation,
      classifyTermination: d.classifyTermination,
    },
  );
}

function labelOutliers(samples: CompletedSample[]): void {
  for (const group of grouped(
    samples.filter((sample) => !sample.warmup && sample.valid),
    (sample) =>
      `${sample.caseOrdinal}:${sample.implementation.implementationId}`,
  ).values()) {
    const labels = labelIqrOutliers(group.map((sample) => sample.totalNs));
    group.forEach((sample, index) => {
      sample.outlier = labels[index]!;
    });
  }
}

function aggregateBenchmarkStatus(
  samples: readonly CompletedSample[],
): TerminationCause {
  return (
    samples.find((sample) => sample.status !== "passed")?.status ?? "passed"
  );
}

function determineComparability(samples: readonly CompletedSample[]): {
  readonly comparable: boolean;
  readonly reason: string | null;
} {
  if (samples.some((sample) => sample.cpuWeightApplied !== true))
    return { comparable: false, reason: "cpu-control-unavailable" };
  return { comparable: true, reason: null };
}

function resultOf(
  runId: RunId,
  state: "completed" | "failed",
  prepared: Prepared,
  samples: readonly CompletedSample[],
  warmups: number,
  sampleCount: number,
  orderSeed: string,
  comparability: {
    readonly comparable: boolean;
    readonly reason: string | null;
  },
): BenchmarkCommandResult {
  const baseline = prepared.implementations[0]!;
  const implementations = prepared.implementations.map((implementation) => {
    const own = samples.filter(
      (sample) =>
        sample.implementation.implementationId ===
        implementation.implementationId,
    );
    const statistics = calculateBenchmarkStatistics(statisticSamples(own));
    const delta =
      comparability.comparable && implementation !== baseline
        ? calculatePairedBaselineDelta(
            samplesToPaired(
              samples.filter(
                (sample) =>
                  sample.implementation.implementationId ===
                  baseline.implementationId,
              ),
            ),
            samplesToPaired(own),
          )
        : null;
    return Object.freeze({
      implementationId: implementation.implementationId,
      path: implementation.relativePath,
      sourceSha256: implementation.sourceSha256,
      baseline: implementation === baseline,
      statistics: jsonStatistics(statistics),
      pairedMedianDeltaNs: delta?.medianDeltaNs?.toString() ?? null,
      relativeDelta: jsonRatio(delta?.relativeDelta ?? null),
    });
  });
  return Object.freeze({
    runId: String(runId),
    state,
    warmups,
    sampleCount,
    orderSeed,
    methodologyVersion: BENCHMARK_METHODOLOGY_VERSION,
    benchmarkPlanSha256: prepared.planSha256,
    comparability: comparability.comparable ? "comparable" : "non_comparable",
    comparabilityReason: comparability.reason,
    implementations: Object.freeze(implementations),
  });
}

async function persist(
  prepared: Prepared,
  runId: RunId,
  state: "completed" | "failed",
  status: TerminationCause,
  startedAt: string,
  finishedAt: string,
  startedNs: bigint,
  finishedNs: bigint,
  warmups: number,
  sampleCount: number,
  orderSeed: string,
  samples: readonly CompletedSample[],
  comparability: {
    readonly comparable: boolean;
    readonly reason: string | null;
  },
  d: BenchmarkDependencies,
): Promise<void> {
  const limitsJson = JSON.stringify(prepared.context.limits);
  const metadata = d.runtimeMetadata();
  const environment = await collectBenchmarkEnvironment(metadata);
  const environmentId = `environment-${fingerprintBenchmarkEnvironment(environment, limitsJson)}`;
  const problemId = `problem-${prepared.context.problem.slug}`;
  const caseByOrdinal = new Map<number, string>();
  for (const sample of samples)
    caseByOrdinal.set(sample.caseOrdinal, sample.caseId);
  await d.transaction.transact(async (uow) => {
    const existing = await uow.problems.findBySlug(
      prepared.context.problem.slug,
    );
    const persistedProblemId = existing?.problem_id ?? problemId;
    if (existing === null)
      await uow.problems.register({
        problem_id: problemId,
        slug: prepared.context.problem.slug,
        schema_version: prepared.context.problem.schemaVersion,
        title: prepared.context.problem.title,
        created_at: startedAt,
        updated_at: startedAt,
      });
    await uow.environments.register({
      environment_id: environmentId,
      host_fingerprint: environmentId.slice("environment-".length),
      kernel: environment.kernel,
      cpu_model: environment.cpuModel,
      python_version: environment.pythonVersion,
      uv_version: environment.uvVersion,
      node_version: environment.nodeVersion,
      sandbox_mode: environment.sandboxMode,
      database_mode: environment.databaseMode,
      cpu_governor: environment.cpuGovernor,
      cpu_frequency: environment.cpuFrequency,
      limits_json: limitsJson,
    });
    for (const implementation of prepared.implementations)
      await uow.implementations.register({
        implementation_id: implementation.implementationId,
        problem_id: persistedProblemId,
        path: implementation.relativePath,
        role: "solution",
        content_sha256: implementation.sourceSha256,
        runtime: prepared.context.problem.runtime,
        created_at: startedAt,
      });
    await uow.runs.commitBenchmark(
      {
        runId,
        slug: prepared.context.problem.slug,
        state,
        status,
        problemFingerprint: sha256Text(
          JSON.stringify({
            problem: prepared.context.problem,
            plan: prepared.planSha256,
          }),
        ),
        seed: null,
        limits: prepared.context.limits,
        inputCodecVersion: prepared.context.problem.inputCodec,
        outputCodecVersion: prepared.context.problem.outputCodec,
        comparisonPolicyVersion: prepared.context.problem.comparisonPolicy,
        inputHash: sha256Text(
          samples.map((sample) => sample.inputHash).join(""),
        ),
        outputHash: null,
        generation: initialGeneration(),
        wallTimeUtc: startedAt,
        durationMs: Number((finishedNs - startedNs) / 1_000_000n),
      },
      {
        problemId: persistedProblemId,
        command: "benchmark",
        environmentId,
        methodologyVersion: BENCHMARK_METHODOLOGY_VERSION,
        warmups,
        sampleCount,
        orderSeed,
        planSha256: prepared.planSha256,
        comparable: comparability.comparable,
        comparabilityReason: comparability.reason,
        finishedAt,
      },
    );
    for (
      let caseOrdinal = 0;
      caseOrdinal < prepared.cases.length;
      caseOrdinal += 1
    ) {
      const caseSamples = samples.filter(
        (sample) => sample.caseOrdinal === caseOrdinal,
      );
      const caseId =
        caseByOrdinal.get(caseOrdinal) ?? String(toCaseId(identifier(d)));
      const encoded = caseSamples[0];
      await uow.cases.commit({
        case_id: caseId,
        run_id: String(runId),
        ordinal: caseOrdinal,
        input_sha256: encoded?.inputHash ?? sha256Text(""),
        input_bytes: BigInt(encoded?.inputBytes ?? 0),
        status: caseSamples.every((sample) => sample.status === "passed")
          ? "passed"
          : "nonzero_exit",
      });
      for (const sample of caseSamples) {
        await uow.benchmarks.commitSample(sampleRow(sample, runId, caseId));
      }
      for (const implementation of prepared.implementations)
        await uow.benchmarks.commitAggregate(
          aggregateRow(
            identifier(d),
            runId,
            caseId,
            implementation,
            caseSamples.filter(
              (sample) => sample.implementation === implementation,
            ),
          ),
        );
    }
  });
}

function sampleRow(
  sample: CompletedSample,
  runId: RunId,
  durableCaseId: string,
): BenchmarkSampleRow {
  return {
    sample_id: sample.sampleId,
    run_id: String(runId),
    case_id: durableCaseId,
    implementation_id: sample.implementation.implementationId,
    ordinal: sample.ordinal,
    warmup: sample.warmup ? 1 : 0,
    status: sample.status,
    setup_ns: sample.setupNs,
    target_ns: sample.targetNs,
    total_ns: sample.totalNs,
    peak_memory_bytes: sample.peakMemoryBytes,
    raw_json: JSON.stringify({
      schemaVersion: 1,
      caseOrdinal: sample.caseOrdinal,
      ordinal: sample.ordinal,
      warmup: sample.warmup,
      inputSha256: sample.inputHash,
      inputBytes: sample.inputBytes,
      setupNs: nullableText(sample.setupNs),
      targetNs: nullableText(sample.targetNs),
      totalNs: sample.totalNs.toString(),
      peakMemoryBytes: nullableText(sample.peakMemoryBytes),
      cpuWeightApplied: sample.cpuWeightApplied,
      outlier: sample.outlier,
      execution: sample.raw,
    }),
  };
}

function aggregateRow(
  aggregateId: string,
  runId: RunId,
  caseId: string,
  implementation: PreparedImplementation,
  samples: readonly CompletedSample[],
): BenchmarkAggregateRow {
  const stats = calculateBenchmarkStatistics(statisticSamples(samples));
  return {
    aggregate_id: aggregateId,
    run_id: String(runId),
    implementation_id: implementation.implementationId,
    case_id: caseId,
    valid_count: stats.validCount,
    failed_count: stats.failedCount,
    min_ns: stats.minNs,
    median_ns: stats.medianNs,
    p90_ns: stats.p90Ns,
    p95_ns: stats.p95Ns,
    p99_ns: stats.p99Ns,
    max_ns: stats.maxNs,
    mean_ns: stats.meanNs,
    stddev_ns: stats.stddevNs,
    memory_median_bytes: stats.memoryMedianBytes,
    memory_p95_bytes: stats.memoryP95Bytes,
    memory_max_bytes: stats.memoryMaxBytes,
  };
}

function statisticSamples(samples: readonly CompletedSample[]) {
  return samples.map((sample) => ({
    warmup: sample.warmup,
    valid: sample.valid,
    targetNs: sample.valid ? sample.totalNs : null,
    peakMemoryBytes: sample.peakMemoryBytes,
  }));
}
function samplesToPaired(samples: readonly CompletedSample[]) {
  return samples.map((sample) => ({
    caseOrdinal: sample.caseOrdinal,
    ordinal: sample.ordinal,
    warmup: sample.warmup,
    valid: sample.valid,
    targetNs: sample.valid ? sample.totalNs : null,
  }));
}
function sameOutput(
  version: string,
  expected: CanonicalValue,
  actual: CanonicalValue,
): boolean {
  return createOutputComparator().compare(expected, actual, {
    version,
    equality: "semantic",
    normalizeWhitespace: false,
  } satisfies ComparisonPolicy).equal;
}
function jsonStatistics(
  stats: BenchmarkStatistics,
): BenchmarkSummaryStatistics {
  return {
    count: stats.count,
    validCount: stats.validCount,
    failedCount: stats.failedCount,
    minNs: nullableText(stats.minNs),
    medianNs: nullableText(stats.medianNs),
    p90Ns: nullableText(stats.p90Ns),
    p95Ns: nullableText(stats.p95Ns),
    p99Ns: nullableText(stats.p99Ns),
    maxNs: nullableText(stats.maxNs),
    meanNs: nullableText(stats.meanNs),
    stddevNs: nullableText(stats.stddevNs),
    memoryMedianBytes: nullableText(stats.memoryMedianBytes),
    memoryP95Bytes: nullableText(stats.memoryP95Bytes),
    memoryMaxBytes: nullableText(stats.memoryMaxBytes),
  };
}
function jsonRatio(
  ratio: ExactRatio | null,
): { readonly numerator: string; readonly denominator: string } | null {
  return ratio === null
    ? null
    : Object.freeze({
        numerator: ratio.numerator.toString(),
        denominator: ratio.denominator.toString(),
      });
}
function grouped<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const itemsForKey = result.get(key) ?? [];
    itemsForKey.push(item);
    result.set(key, itemsForKey);
  }
  return result;
}
function isValidExecution(execution: IsolatedExecution): boolean {
  return (
    execution.status === "passed" &&
    execution.exception === null &&
    execution.output !== null
  );
}
function resolveWithinRoot(root: string, candidate: string): string {
  return resolve(root, candidate);
}
function relativeWithinRoot(root: string, path: string): string {
  const value = relative(root, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`))
    throw new Error("solution path escapes the problem root");
  return value.split(sep).join("/");
}
function canonicalSeed(seed: string): string {
  return formatUint64Seed(parseUint64Seed(seed));
}
function randomOrderSeed(): string {
  return BigInt(`0x${randomBytes(8).toString("hex")}`).toString();
}
function identifier(d: BenchmarkDependencies): string {
  return (d.createId ?? randomUUID)();
}
async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function nullableText(value: bigint | null): string | null {
  return value?.toString() ?? null;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function canceled(
  runId: RunId,
  warmups: number,
  sampleCount: number,
  orderSeed: string,
  planSha256: string,
): BenchmarkOutcome {
  return {
    status: "canceled",
    result: {
      runId: String(runId),
      state: "canceled",
      warmups,
      sampleCount,
      orderSeed,
      methodologyVersion: BENCHMARK_METHODOLOGY_VERSION,
      benchmarkPlanSha256: planSha256,
      comparability: "non_comparable",
      comparabilityReason: "canceled",
      implementations: [],
    },
    diagnostics: [{ code: "canceled", message: "benchmark canceled" }],
  };
}
