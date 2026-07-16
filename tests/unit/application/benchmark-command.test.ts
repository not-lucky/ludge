import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeBenchmarkCommand } from "../../../src/application/benchmark-command.js";
import type { RawProcessResult } from "../../../src/domain/index.js";
import type { RunContext } from "../../../src/infrastructure/problem.js";
import { encodeResponseLine } from "../../../src/judging/codec/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        import("node:fs/promises").then(({ rm }) =>
          rm(root, { recursive: true, force: true }),
        ),
      ),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "palestra-benchmark-"));
  roots.push(root);
  const problem = join(root, "problems", "sample");
  await mkdir(join(problem, "cases"), { recursive: true });
  await writeFile(
    join(problem, "problem.yaml"),
    [
      "schemaVersion: 1",
      "slug: sample",
      "title: Sample",
      "entrypoint: solution.py",
      "limits: {}",
      "casesDir: cases",
      "args: [int]",
      "returns: int",
    ].join("\n"),
  );
  await writeFile(
    join(problem, "one.py"),
    "def solution(value): return value\n",
  );
  await writeFile(
    join(problem, "two.py"),
    "def solution(value): return value\n",
  );
  await writeFile(
    join(problem, "cases", "one.json"),
    JSON.stringify({ input: [1], expected: 1 }),
  );
  return root;
}

function raw(stdout: Uint8Array, cpuWeightApplied = true): RawProcessResult {
  return {
    termination: "exited",
    exitCode: 0,
    signal: null,
    stdout: { data: stdout, truncated: false, totalBytes: stdout.length },
    stderr: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
    resources: {
      wallTimeMs: 1,
      cpuTimeMs: 1,
      memoryPeakBytes: 10,
      oomKills: 0,
      peakProcessCount: 1,
      cpuWeightApplied,
    },
    cleanupDiagnostics: [],
    phases: { setupNs: 2n, targetNs: 3n },
  };
}

function dependencies(root: string, cpuWeightApplied = true) {
  let id = 0;
  let request:
    { runId: string; caseId: string; codecVersion: string } | undefined;
  const samples: unknown[] = [];
  const aggregates: unknown[] = [];
  const transaction = {
    transact: async (work: (uow: never) => Promise<unknown>) =>
      work({
        problems: {
          findBySlug: async () => null,
          register: async () => undefined,
        },
        environments: { register: async () => undefined },
        implementations: { register: async () => undefined },
        runs: { commitBenchmark: async () => undefined },
        cases: { commit: async () => undefined },
        benchmarks: {
          commitSample: async (sample: unknown) => {
            samples.push(sample);
          },
          commitAggregate: async (aggregate: unknown) => {
            aggregates.push(aggregate);
          },
        },
      } as never),
  } as never;
  let tick = 0n;
  return {
    dependencies: {
      invocationDirectory: root,
      cancellation: {
        isCancellationRequested: false,
        onCancel: () => () => undefined,
        throwIfCancellationRequested: () => undefined,
      },
      clock: {
        monotonicNs: () => ++tick * 10n,
        wallTimeUtc: () => "2025-01-01T00:00:00.000Z",
      },
      prepareRun: async () => ({
        context: {
          problemRoot: join(root, "problems", "sample"),
          problem: {
            schemaVersion: 1,
            slug: "sample",
            title: "Sample",
            entrypoint: "solution.py",
            casesDir: "cases",
            limits: {},
            runtime: "python-uv",
            inputCodec: "tagged-jsonl-v1",
            outputCodec: "tagged-jsonl-v1",
            comparisonPolicy: "exact-v1",
            kind: "function",
            args: [{ kind: "int" }],
            returns: { kind: "int" },
          },
          limits: {
            wallTimeMs: 2_000,
            cpuTimeMs: 2_000,
            memoryBytes: 1,
            stdoutBytes: 1_024,
            stderrBytes: 1_024,
            combinedOutputBytes: 2_048,
            inputBytes: 1_024,
            fileSizeBytes: 1,
            processCount: 1,
            openDescriptors: 1,
            tempStorageBytes: 1,
            concurrencyPerCase: 1,
          },
          assets: {
            entrypoint: join(root, "problems", "sample", "solution.py"),
            casesDir: join(root, "problems", "sample", "cases"),
            statement: join(root, "problems", "sample", "problem.md"),
          },
          unsafeLocal: false,
          stateDirectory: join(root, ".palestra"),
          cgroupParentPath: "/cgroup",
          uvPath: "/uv",
          pythonPath: "/python",
        } satisfies RunContext,
        runner: {
          run: async (value: {
            runId: string;
            caseId: string;
            outputCodecVersion: string;
          }) => {
            request = {
              runId: value.runId,
              caseId: value.caseId,
              codecVersion: value.outputCodecVersion,
            };
            return raw(
              encodeResponseLine({
                protocolVersion: 1,
                kind: "response",
                runId: request.runId,
                caseId: request.caseId,
                codecVersion: request.codecVersion,
                messageLimitBytes: 1024,
                output: { tag: "int", value: 1n },
                exception: null,
              }),
              cpuWeightApplied,
            );
          },
          beginProfile: () => ({ finish: () => ({}) }),
        },
      }),
      transaction,
      classifyTermination: (value: RawProcessResult) =>
        value.exitCode === 0 ? "passed" : "nonzero_exit",
      readText: (path: string) => readFile(path, "utf8"),
      createId: () => `id-${id++}`,
      chooseOrderSeed: () => "7",
      runtimeMetadata: () => ({
        pythonVersion: "3.12",
        uvVersion: "0.5",
        sandboxMode: "test",
        databaseMode: "sqlite-wal-local",
      }),
    },
    samples,
    aggregates,
  } as const;
}

describe("benchmark command", () => {
  it("discards warmups, preserves ordinal continuity, and persists only measured statistics", async () => {
    const root = await project();
    const setup = dependencies(root);
    const outcome = await executeBenchmarkCommand(
      {
        slug: "sample",
        solutions: ["one.py", "two.py"],
        warmup: 1,
        samples: 2,
        unsafeLocal: false,
      },
      setup.dependencies,
    );
    expect(outcome.status).toBe("passed");
    expect(outcome.result).toMatchObject({
      comparability: "comparable",
      warmups: 1,
      sampleCount: 2,
    });
    expect(setup.samples).toHaveLength(6);
    const persistedSamples = setup.samples as readonly {
      readonly ordinal: number;
      readonly warmup: number;
    }[];
    expect(
      persistedSamples.map((sample) => [sample.ordinal, sample.warmup]),
    ).toEqual([
      [0, 1],
      [0, 1],
      [1, 0],
      [1, 0],
      [2, 0],
      [2, 0],
    ]);
    expect(setup.aggregates).toHaveLength(2);
    const persistedAggregates = setup.aggregates as readonly {
      readonly valid_count: number;
    }[];
    expect(
      persistedAggregates.map((aggregate) => aggregate.valid_count),
    ).toEqual([2, 2]);
  });

  it("labels CPU-control absence as non-comparable and does not fabricate deltas", async () => {
    const root = await project();
    const setup = dependencies(root, false);
    const outcome = await executeBenchmarkCommand(
      {
        slug: "sample",
        solutions: ["one.py", "two.py"],
        warmup: 0,
        samples: 1,
        unsafeLocal: false,
      },
      setup.dependencies,
    );
    expect(outcome.result).toMatchObject({
      comparability: "non_comparable",
      comparabilityReason: "cpu-control-unavailable",
    });
    expect(outcome.result?.implementations[1]?.pairedMedianDeltaNs).toBeNull();
  });

  it("preserves a validation execution failure instead of misreporting it as wrong_answer", async () => {
    const root = await project();
    const setup = dependencies(root);
    const outcome = await executeBenchmarkCommand(
      {
        slug: "sample",
        solutions: ["one.py", "two.py"],
        warmup: 0,
        samples: 1,
        unsafeLocal: false,
      },
      { ...setup.dependencies, classifyTermination: () => "tle_wall" },
    );
    expect(outcome).toMatchObject({ status: "tle_wall", result: null });
  });
});
