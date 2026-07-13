import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeTestCommand } from "../../../src/application/test-command.js";
import type { TestInvocation } from "../../../src/application/test-command.js";
import type { RawProcessResult } from "../../../src/domain/index.js";
import { encodeResponseLine } from "../../../src/judging/codec/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  }));
});

function command(_root: string): TestInvocation {
  return { slug: "sample", unsafeLocal: false };
}

function raw(stdout: Uint8Array): RawProcessResult {
  return {
    termination: "exited", exitCode: 0, signal: null,
    stdout: { data: stdout, truncated: false, totalBytes: stdout.length },
    stderr: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
    resources: { wallTimeMs: 1, cpuTimeMs: 1, memoryPeakBytes: 1, oomKills: 0, peakProcessCount: 1 },
    cleanupDiagnostics: [],
  };
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "palestra-test-command-"));
  roots.push(root);
  const problem = join(root, "problems", "sample");
  await mkdir(join(problem, "cases"), { recursive: true });
  await writeFile(join(problem, "problem.yaml"), [
    "schemaVersion: 1", "slug: sample", "title: Sample", "entrypoint: solution.py",
    "runtime: python-uv", "inputCodec: tagged-jsonl-v1", "outputCodec: tagged-jsonl-v1",
    "comparisonPolicy: exact-v1", "limits: {}", "casesDir: cases",
  ].join("\n"));
  await writeFile(join(problem, "solution.py"), "def solution(value): return value\n");
  await writeFile(join(problem, "cases", "one.json"), JSON.stringify({ input: { tag: "int", value: 1 }, expected: { tag: "int", value: 1 } }));
  return root;
}

function dependencies(root: string, responder: (request: { readonly runId: string; readonly caseId: string; readonly codecVersion: string }) => RawProcessResult) {
  let id = 0;
  const transaction = { transact: async (work: (uow: never) => Promise<unknown>) => work({
    problems: { register: async () => undefined }, implementations: { register: async () => undefined },
    runs: { commit: async () => undefined }, cases: { commit: async () => undefined },
    executions: { commit: async () => undefined }, artifacts: { commit: async () => undefined },
  } as never) } as never;
  return {
    invocationDirectory: root, environment: {
      PALESTRA_UV_PATH: "/uv", PALESTRA_PYTHON_PATH: "/python", PALESTRA_UV_CACHE_DIR: "/cache", PALESTRA_TEMP_DIR: "/tmp", PALESTRA_CGROUP_PARENT: "/cgroup",
    },
    cancellation: { isCancellationRequested: false, onCancel: () => () => undefined, throwIfCancellationRequested: () => undefined },
    clock: { monotonicNs: (() => { let now = 0n; return () => now++ * 1_000_000n; })(), wallTimeUtc: () => "2025-01-01T00:00:00.000Z" },
    probes: { isExecutable: async () => true, exists: async () => true, availableControls: async () => new Set(["cgroup"] as const) },
    supportedRuntimes: new Set(["python-uv"]), requiredControls: ["cgroup"] as const,
    classifyTermination: (value: RawProcessResult) => value.exitCode === 0 ? "passed" : "nonzero_exit",
    createBundle: () => ({
      backendId: "fake", runtime: { backendId: "fake", describe: () => ({ id: "python-uv", displayName: "fake", inputCodecVersion: "tagged-jsonl-v1", outputCodecVersion: "tagged-jsonl-v1" }), buildInvocation: () => ({ executable: "fake", args: [] }) },
      inputCodec: {} as never, outputCodec: {} as never,
      sandbox: { backendId: "fake", run: async (_invocation: unknown, _limits: unknown, _cancellation: unknown) => responder(lastRequest!) },
      profiler: { backendId: "fake", begin: () => ({ finish: () => ({}) }) },
    }),
    transaction,
    readText: (path: string) => readFile(path, "utf8"),
    createId: () => `id-${id++}`,
  } as const;
}
let lastRequest: { runId: string; caseId: string; codecVersion: string } | undefined;

describe("test command facade", () => {
  it("executes every selected case and returns a passed JSON-safe summary", async () => {
    const root = await project();
    const deps = dependencies(root, () => raw(encodeResponseLine({ protocolVersion: 1, kind: "response", runId: lastRequest!.runId, caseId: lastRequest!.caseId, codecVersion: "tagged-jsonl-v1", messageLimitBytes: 1024, output: { tag: "int", value: 1n }, exception: null })));
    // Capture the immutable request identity by wrapping the runtime factory.
    const original = deps.createBundle;
    const withRequest = { ...deps, createBundle: () => {
      const bundle = original();
      return { ...bundle, runtime: { ...bundle.runtime, buildInvocation: (request: { runId: string; caseId: string; outputCodecVersion: string }) => { lastRequest = { runId: request.runId, caseId: request.caseId, codecVersion: request.outputCodecVersion }; return { executable: "fake", args: [] }; } } };
    } };
    const result = await executeTestCommand(command(root), withRequest);
    expect(result.status).toBe("passed");
    expect(result.result).toMatchObject({ caseCount: 1, passedCaseCount: 1, state: "completed" });
  });

  it("keeps a wrong-answer verdict when post-verdict persistence fails", async () => {
    const root = await project();
    const deps = dependencies(root, () => raw(encodeResponseLine({ protocolVersion: 1, kind: "response", runId: lastRequest!.runId, caseId: lastRequest!.caseId, codecVersion: "tagged-jsonl-v1", messageLimitBytes: 1024, output: { tag: "int", value: 2n }, exception: null })));
    const original = deps.createBundle;
    const withRequest = { ...deps, transaction: { transact: vi.fn(async () => { throw new Error("disk unavailable"); }) }, createBundle: () => {
      const bundle = original();
      return { ...bundle, runtime: { ...bundle.runtime, buildInvocation: (request: { runId: string; caseId: string; outputCodecVersion: string }) => { lastRequest = { runId: request.runId, caseId: request.caseId, codecVersion: request.outputCodecVersion }; return { executable: "fake", args: [] }; } } };
    } };
    const result = await executeTestCommand(command(root), withRequest);
    expect(result.status).toBe("wrong_answer");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "persistence_failed" }));
  });
});
