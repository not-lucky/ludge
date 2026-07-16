import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeTestCommand } from "../../../src/application/test-command.js";
import type { TestInvocation } from "../../../src/application/test-command.js";
import type { RawProcessResult } from "../../../src/domain/index.js";
import type { RunContext } from "../../../src/infrastructure/problem.js";
import { encodeResponseLine } from "../../../src/judging/codec/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function command(_root: string): TestInvocation {
  return { slug: "sample", unsafeLocal: false };
}

function raw(stdout: Uint8Array): RawProcessResult {
  return {
    termination: "exited",
    exitCode: 0,
    signal: null,
    stdout: { data: stdout, truncated: false, totalBytes: stdout.length },
    stderr: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
    resources: {
      wallTimeMs: 1,
      cpuTimeMs: 1,
      memoryPeakBytes: 1,
      oomKills: 0,
      peakProcessCount: 1,
    },
    cleanupDiagnostics: [],
  };
}

async function project(
  casesDocument = JSON.stringify({ input: [1], expected: 1 }),
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "palestra-test-command-"));
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
    join(problem, "solution.py"),
    "def solution(value): return value\n",
  );
  await writeFile(join(problem, "cases", "one.json"), casesDocument);
  return root;
}

function dependencies(
  root: string,
  responder: (request: {
    readonly runId: string;
    readonly caseId: string;
    readonly codecVersion: string;
  }) => RawProcessResult | Promise<RawProcessResult>,
) {
  let id = 0;
  const transaction = {
    transact: async (work: (uow: never) => Promise<unknown>) =>
      work({
        problems: { register: async () => undefined },
        implementations: { register: async () => undefined },
        runs: { commit: async () => undefined },
        cases: { commit: async () => undefined },
        executions: { commit: async () => undefined },
        artifacts: { commit: async () => undefined },
      } as never),
  } as never;
  return {
    invocationDirectory: root,
    cancellation: {
      isCancellationRequested: false,
      onCancel: () => () => undefined,
      throwIfCancellationRequested: () => undefined,
    },
    clock: {
      monotonicNs: (() => {
        let now = 0n;
        return () => now++ * 1_000_000n;
      })(),
      wallTimeUtc: () => "2025-01-01T00:00:00.000Z",
    },
    classifyTermination: (value: RawProcessResult) =>
      value.exitCode === 0 ? "passed" : "nonzero_exit",
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
        run: async (request: {
          runId: string;
          caseId: string;
          outputCodecVersion: string;
        }) => {
          lastRequest = {
            runId: request.runId,
            caseId: request.caseId,
            codecVersion: request.outputCodecVersion,
          };
          return responder(lastRequest);
        },
        beginProfile: () => ({ finish: () => ({}) }),
      },
    }),
    transaction,
    readText: (path: string) => readFile(path, "utf8"),
    createId: () => `id-${id++}`,
  } as const;
}
let lastRequest:
  { runId: string; caseId: string; codecVersion: string } | undefined;

describe("test command facade", () => {
  it("executes every selected case and returns a passed JSON-safe summary", async () => {
    const root = await project();
    const deps = dependencies(root, () =>
      raw(
        encodeResponseLine({
          protocolVersion: 1,
          kind: "response",
          runId: lastRequest!.runId,
          caseId: lastRequest!.caseId,
          codecVersion: "tagged-jsonl-v1",
          messageLimitBytes: 1024,
          output: { tag: "int", value: 1n },
          exception: null,
        }),
      ),
    );
    const result = await executeTestCommand(command(root), deps);
    expect(result.status).toBe("passed");
    expect(result.result).toMatchObject({
      caseCount: 1,
      passedCaseCount: 1,
      state: "completed",
    });
  });

  it("uses the bounded automatic worker default when --jobs is omitted", async () => {
    const root = await project(
      JSON.stringify({
        cases: [
          { input: [1], expected: 1 },
          { input: [2], expected: 2 },
          { input: [3], expected: 3 },
        ],
      }),
    );
    const started: Array<(value: RawProcessResult) => void> = [];
    const deps = dependencies(
      root,
      () => new Promise<RawProcessResult>((resolve) => started.push(resolve)),
    );
    const resultPromise = executeTestCommand(command(root), {
      ...deps,
      defaultJobs: () => 2,
    });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    started[0]!(raw(new Uint8Array()));
    started[1]!(raw(new Uint8Array()));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    started[2]!(raw(new Uint8Array()));
    const result = await resultPromise;
    expect(result.result?.caseCount).toBe(3);
  });

  it("runs a bounded complete suite and orders outcomes by source rather than finish order", async () => {
    const root = await project(
      JSON.stringify({
        cases: [
          { input: [1], expected: 1 },
          { input: [2], expected: 2 },
          { input: [3], expected: 3 },
          { input: [4], expected: 4 },
        ],
      }),
    );
    const started: string[] = [];
    const resolvers: Array<(value: RawProcessResult) => void> = [];
    let active = 0;
    let maximumActive = 0;
    const deps = dependencies(
      root,
      (request) =>
        new Promise<RawProcessResult>((resolve) => {
          started.push(request.caseId);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          resolvers.push((result) => {
            active -= 1;
            resolve(result);
          });
        }),
    );
    const resultPromise = executeTestCommand(
      { ...command(root), jobs: 2 },
      deps,
    );
    await vi.waitFor(() => expect(started).toHaveLength(2));
    // Resolve source ordinal 1 first, then ordinal 0. Generic empty protocol
    // responses make every case fail without depending on request identity.
    resolvers[1]!(raw(new Uint8Array()));
    resolvers[0]!(raw(new Uint8Array()));
    await vi.waitFor(() => expect(started).toHaveLength(4));
    resolvers[2]!(raw(new Uint8Array()));
    resolvers[3]!(raw(new Uint8Array()));
    const result = await resultPromise;
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(result.result?.caseCount).toBe(4);
    expect(result.result?.cases.map((item) => item.path)).toEqual([
      "cases/one.json#0",
      "cases/one.json#1",
      "cases/one.json#2",
      "cases/one.json#3",
    ]);
    // All responses are protocol failures, but the displayed/artifact source
    // stays source ordinal zero even though ordinal one completed first.
    expect(result.result?.firstFailure?.path).toBe("cases/one.json#0");
  });

  it("uses source-order first failure as the mismatch artifact despite finish order", async () => {
    const root = await project(
      JSON.stringify({
        cases: [
          { input: [1], expected: 1 },
          { input: [2], expected: 2 },
        ],
      }),
    );
    const calls: Array<{
      request: { runId: string; caseId: string; codecVersion: string };
      resolve: (value: RawProcessResult) => void;
    }> = [];
    const deps = dependencies(
      root,
      (request) =>
        new Promise<RawProcessResult>((resolve) =>
          calls.push({ request, resolve }),
        ),
    );
    const artifact = vi.fn(
      async (request: { case: { relativePath: string } }) => {
        expect(request.case.relativePath).toBe("cases/one.json#0");
        return { path: "artifact.json", sha256: "hash", sizeBytes: 1n };
      },
    );
    const execution = executeTestCommand(
      { ...command(root), jobs: 2 },
      {
        ...deps,
        writeMismatchArtifact: artifact,
      },
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const response = (item: (typeof calls)[number]) =>
      raw(
        encodeResponseLine({
          protocolVersion: 1,
          kind: "response",
          runId: item.request.runId,
          caseId: item.request.caseId,
          codecVersion: item.request.codecVersion,
          messageLimitBytes: 1024,
          output: { tag: "int", value: 99n },
          exception: null,
        }),
      );
    calls[1]!.resolve(response(calls[1]!));
    calls[0]!.resolve(response(calls[0]!));
    const result = await execution;
    expect(result.status).toBe("wrong_answer");
    expect(artifact).toHaveBeenCalledOnce();
    expect(result.result?.firstFailure?.path).toBe("cases/one.json#0");
  });

  it("cancellation drains in-flight runners without scheduling more", async () => {
    const root = await project(
      JSON.stringify({
        cases: [
          { input: [1], expected: 1 },
          { input: [2], expected: 2 },
          { input: [3], expected: 3 },
        ],
      }),
    );
    let canceled = false;
    const started: Array<(value: RawProcessResult) => void> = [];
    const deps = dependencies(
      root,
      () => new Promise<RawProcessResult>((resolve) => started.push(resolve)),
    );
    const cancellation = {
      get isCancellationRequested() {
        return canceled;
      },
      onCancel: () => () => undefined,
      throwIfCancellationRequested: () => undefined,
    };
    const resultPromise = executeTestCommand(
      { ...command(root), jobs: 2 },
      {
        ...deps,
        cancellation,
      },
    );
    await vi.waitFor(() => expect(started).toHaveLength(2));
    canceled = true;
    started[0]!(raw(new Uint8Array()));
    started[1]!(raw(new Uint8Array()));
    const result = await resultPromise;
    expect(started).toHaveLength(2);
    expect(result.status).toBe("canceled");
  });

  it("keeps a wrong-answer verdict when post-verdict persistence fails", async () => {
    const root = await project();
    const deps = dependencies(root, () =>
      raw(
        encodeResponseLine({
          protocolVersion: 1,
          kind: "response",
          runId: lastRequest!.runId,
          caseId: lastRequest!.caseId,
          codecVersion: "tagged-jsonl-v1",
          messageLimitBytes: 1024,
          output: { tag: "int", value: 2n },
          exception: null,
        }),
      ),
    );
    const withRequest = {
      ...deps,
      transaction: {
        transact: vi.fn(async () => {
          throw new Error("disk unavailable");
        }),
      },
    };
    const result = await executeTestCommand(command(root), withRequest);
    expect(result.status).toBe("wrong_answer");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persistence_failed" }),
    );
  });

  it("surfaces target exception message in diagnostics on protocol_error", async () => {
    const root = await project();
    const deps = dependencies(root, () =>
      raw(
        encodeResponseLine({
          protocolVersion: 1,
          kind: "response",
          runId: lastRequest!.runId,
          caseId: lastRequest!.caseId,
          codecVersion: "tagged-jsonl-v1",
          messageLimitBytes: 1024,
          output: null,
          exception: {
            tag: "exception",
            type: "MemoryError",
            message: "Out of memory",
            details: null,
          },
        }),
      ),
    );
    const result = await executeTestCommand(command(root), deps);
    expect(result.status).toBe("protocol_error");
    expect(result.diagnostics).toContainEqual({
      code: "protocol_error",
      message: "Target exception: MemoryError: Out of memory",
    });
  });
});
