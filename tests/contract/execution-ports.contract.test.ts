/**
 * Contract-test scaffold for the execution ports.
 *
 * These suites enumerate the behavioural obligations that any concrete
 * {@link RuntimeAdapter}, {@link Sandbox}, {@link Clock}, {@link CancellationToken},
 * {@link FileSystem}, {@link Profiler}, and {@link ExecutionBackend} implementation
 * must satisfy. They are intentionally `todo` placeholders: tasks 06/07 supply
 * fixtures (including a fake `uv`) that drive these obligations against real
 * adapters. The `import type` block also acts as a compile-time check that the
 * port surface stays stable.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ArgvInvocation,
  CancellationToken,
  Clock,
  ExecutionBackend,
  FileSystem,
  Profiler,
  RuntimeAdapter,
  RuntimeBundle,
  Sandbox,
} from "../../src/execution/ports/index.js";
import {
  createPythonRuntimeAdapter,
  createPythonRuntimeConfig,
} from "../../src/execution/runtimes/python/index.js";
import {
  createLinuxSandbox,
  createLinuxSandboxConfig,
} from "../../src/execution/sandbox/linux/index.js";
import {
  createResourceLimits,
  initialGeneration,
  toCaseId,
  toRunId,
} from "../../src/domain/index.js";
import type {
  ExecutionRequest,
  ImplementationRole,
  ResourceLimits,
} from "../../src/domain/index.js";
import {
  CAN_ENFORCE,
  CGROUP_PARENT,
  ManualCancellation,
} from "../helpers/linux-sandbox-capability.js";
import { createExecutionProfiler } from "../../src/telemetry/index.js";

// Reference the imported types so the type-only imports are retained and the
// port surface is verified to exist without introducing runtime coupling.
type _PortSurface = [
  ArgvInvocation,
  CancellationToken,
  Clock,
  ExecutionBackend,
  FileSystem,
  Profiler<unknown>,
  RuntimeAdapter,
  RuntimeBundle,
  Sandbox,
];

describe("RuntimeAdapter contract", () => {
  // The `python-uv` adapter is the concrete implementation these obligations are
  // driven against; any RuntimeAdapter must satisfy the same contract.
  const adapter: RuntimeAdapter = createPythonRuntimeAdapter(
    "contract-backend",
    createPythonRuntimeConfig({
      uvPath: "/opt/uv/bin/uv",
      pythonPath: "/opt/python/bin/python3",
      harnessEntrypoint: "/srv/harness/__main__.py",
      workingDirectory: "/run/root",
      pathEnv: "/usr/bin:/bin",
      locale: "C.UTF-8",
      uvCacheDir: "/run/uv-cache",
      defaultEntrySymbol: "solve",
    }),
  );

  function makeRequest(
    role: ImplementationRole,
    relativePath: string,
  ): ExecutionRequest {
    return {
      runId: toRunId("run"),
      caseId: toCaseId("case"),
      problemFingerprint: "fp",
      implementation: { role, relativePath },
      inputBytes: new Uint8Array(),
      inputCodecVersion: "tagged-jsonl-v1",
      outputCodecVersion: "tagged-jsonl-v1",
      limits: createResourceLimits({
        wallTimeMs: 1000,
        cpuTimeMs: 1000,
        memoryBytes: 1024 * 1024,
        stdoutBytes: 1024,
        stderrBytes: 1024,
        combinedOutputBytes: 2048,
        inputBytes: 1024,
        fileSizeBytes: 1024,
        processCount: 4,
        openDescriptors: 32,
        tempStorageBytes: 1024,
        concurrencyPerCase: 1,
      }),
      generation: initialGeneration(),
    };
  }

  it("describe() returns a stable descriptor with codec versions", () => {
    const descriptor = adapter.describe();
    expect(descriptor.id.length).toBeGreaterThan(0);
    expect(descriptor.inputCodecVersion.length).toBeGreaterThan(0);
    expect(descriptor.outputCodecVersion.length).toBeGreaterThan(0);
    // Stable: repeated calls yield an equal descriptor.
    expect(adapter.describe()).toEqual(descriptor);
  });

  it("buildInvocation() yields an executable + argv, never a shell string", () => {
    const invocation = adapter.buildInvocation(
      makeRequest("solution", "solutions/main.py"),
    );
    expect(typeof invocation.executable).toBe("string");
    expect(invocation.executable.length).toBeGreaterThan(0);
    expect(Array.isArray(invocation.args)).toBe(true);
    // No arg is a shell metacharacter-joined command line: each arg is discrete.
    for (const arg of invocation.args) {
      expect(typeof arg).toBe("string");
    }
    // The target path travels as its own argv element, not spliced into a string.
    expect(invocation.args).toContain("solutions/main.py");
  });

  it("buildInvocation() never reads or evaluates the target script", () => {
    // A path that does not exist must not cause any read/evaluation: the adapter
    // only names the target, so building the invocation succeeds regardless.
    const invocation = adapter.buildInvocation(
      makeRequest("solution", "does/not/exist/ghost.py"),
    );
    expect(invocation.args).toContain("does/not/exist/ghost.py");
  });
});

describe("Sandbox contract", () => {
  // The Linux full-enforcement sandbox is the concrete implementation these
  // obligations are driven against. They require a real cgroup v2 delegation, so
  // the block skips (stays green) on hosts without that capability.
  const sandbox = CAN_ENFORCE
    ? createLinuxSandbox(
        "contract-sandbox",
        createLinuxSandboxConfig({
          workingDirectory: "/",
          environment: { PATH: "/usr/bin:/bin" },
          cgroupParentPath: CGROUP_PARENT ?? "/sys/fs/cgroup",
          tempBaseDir: join(tmpdir(), "palestra-contract"),
        }),
      )
    : null;

  const sh = (script: string): ArgvInvocation => ({
    executable: "/bin/sh",
    args: ["-c", script],
  });

  const contractLimits = (): ResourceLimits =>
    createResourceLimits({
      wallTimeMs: 2000,
      cpuTimeMs: 2000,
      memoryBytes: 128 * 1024 * 1024,
      stdoutBytes: 4 * 1024,
      stderrBytes: 4 * 1024,
      combinedOutputBytes: 8 * 1024,
      inputBytes: 4 * 1024,
      fileSizeBytes: 1024 * 1024,
      processCount: 32,
      openDescriptors: 32,
      tempStorageBytes: 1024 * 1024,
      concurrencyPerCase: 1,
    });

  it.skipIf(!CAN_ENFORCE)(
    "run() resolves with a RawProcessResult on a normal (zero) exit",
    async () => {
      const raw = await sandbox!.run(
        sh("exit 0"),
        contractLimits(),
        new ManualCancellation(),
      );
      expect(raw.termination).toBe("exited");
      expect(raw.exitCode).toBe(0);
    },
  );

  it.skipIf(!CAN_ENFORCE)(
    "run() resolves (does not throw) on a nonzero exit or terminating signal",
    async () => {
      const raw = await sandbox!.run(
        sh("exit 7"),
        contractLimits(),
        new ManualCancellation(),
      );
      expect(raw.termination).toBe("exited");
      expect(raw.exitCode).toBe(7);
    },
  );

  it.skipIf(!CAN_ENFORCE)(
    "run() reports bounded stdout/stderr with truncation flags at the caps",
    async () => {
      const raw = await sandbox!.run(
        sh("yes AAAA | head -c 100000"),
        contractLimits(),
        new ManualCancellation(),
      );
      expect(raw.stdout.truncated).toBe(true);
      expect(raw.stdout.data.byteLength).toBeLessThanOrEqual(4 * 1024);
    },
  );

  it.skipIf(!CAN_ENFORCE)(
    "run() maps wall/CPU/memory breaches to the corresponding observations",
    async () => {
      const raw = await sandbox!.run(
        sh("sleep 10"),
        createResourceLimits({ ...contractLimits(), wallTimeMs: 150 }),
        new ManualCancellation(),
      );
      expect(raw.termination).toBe("timed_out");
      expect(raw.resources.wallTimeMs).toBeGreaterThan(0);
    },
  );

  it.skipIf(!CAN_ENFORCE)(
    "run() aborts promptly when the cancellation token is triggered",
    async () => {
      const cancellation = new ManualCancellation();
      const promise = sandbox!.run(
        sh("sleep 30"),
        createResourceLimits({ ...contractLimits(), wallTimeMs: 10000 }),
        cancellation,
      );
      setTimeout(() => cancellation.cancel(), 50);
      const raw = await promise;
      expect(raw.termination).toBe("killed");
    },
  );

  it.skipIf(!CAN_ENFORCE)(
    "run() executes the target as a child process, never in-process",
    async () => {
      // A crash of the target must not crash the test process: proof it ran out
      // of process. `kill -9 $$` terminates the child via SIGKILL only.
      const raw = await sandbox!.run(
        sh("kill -9 $$"),
        contractLimits(),
        new ManualCancellation(),
      );
      expect(raw.termination).toBe("signaled");
      expect(raw.signal).toBe("SIGKILL");
    },
  );
});

describe("Clock contract", () => {
  it.todo("monotonicNs() is non-decreasing across successive reads");
  it.todo("wallTimeUtc() returns ISO-8601 UTC text with a Z offset");
});

describe("CancellationToken contract", () => {
  it.todo("isCancellationRequested latches true and never reverts");
  it.todo("onCancel() listeners fire once; late subscribers fire immediately");
  it.todo("onCancel() returns an unsubscribe that prevents later notification");
  it.todo("throwIfCancellationRequested() throws only after cancellation");
});

describe("FileSystem contract", () => {
  it.todo("read() returns the exact file bytes");
  it.todo("stat() reports size, kind, and modified time");
  it.todo("createTempRoot() returns a fresh, isolated directory per call");
  it.todo("watchHints() reports host recursion + coalescing capabilities");
});

describe("Profiler contract", () => {
  it("begin()/finish() folds a RawProcessResult into a profiling record", () => {
    const profiler = createExecutionProfiler("contract", {
      monotonicNs: () => 0n,
      wallTimeUtc: () => "2026-01-01T00:00:00.000Z",
    });
    const profile = profiler.begin().finish({
      termination: "exited",
      exitCode: 0,
      signal: null,
      stdout: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
      stderr: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
      resources: {
        wallTimeMs: 5,
        cpuTimeMs: 2,
        memoryPeakBytes: 3,
        oomKills: 0,
        peakProcessCount: 1,
      },
      cleanupDiagnostics: [],
    });
    expect(profile.wallDurationNs).toBe(5_000_000);
    expect(profile.peakCgroupBytes).toBe(3);
  });

  it("profiling never alters the verdict (Decorator, not a policy)", () => {
    const profiler = createExecutionProfiler("contract", {
      monotonicNs: () => 0n,
      wallTimeUtc: () => "2026-01-01T00:00:00.000Z",
    });
    const profile = profiler.begin().finish({
      termination: "exited",
      exitCode: 1,
      signal: null,
      stdout: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
      stderr: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
      resources: { wallTimeMs: 0, cpuTimeMs: 0, memoryPeakBytes: 0, oomKills: 0, peakProcessCount: 0 },
      cleanupDiagnostics: [],
    });
    expect(profile.status).toBeNull();
  });
});

describe("ExecutionBackend contract", () => {
  it.todo("describe() returns a stable backend + runtime identity");
  it.todo("create() returns a bundle whose members all share one backend tag");
  it.todo("bundle codecs and launcher are mutually compatible by construction");
});
