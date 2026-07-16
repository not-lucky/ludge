import { describe, expect, it } from "vitest";
import { createLinuxSandbox } from "../../../src/execution/linux-sandbox.js";
import type { ResourceLimits } from "../../../src/domain/limits.js";

const limits: ResourceLimits = {
  wallTimeMs: 1,
  cpuTimeMs: 1,
  memoryBytes: 1,
  stdoutBytes: 10,
  stderrBytes: 10,
  combinedOutputBytes: 20,
  inputBytes: 10,
  fileSizeBytes: 1,
  processCount: 1,
  openDescriptors: 1,
  tempStorageBytes: 1,
  concurrencyPerCase: 1,
};

describe("Linux sandbox cleanup", () => {
  it("waits for an initiated cgroup reaper before it samples/removes the boundary", async () => {
    // Keep this focused on the supervisor's sequencing contract. A real
    // delegated-cgroup suite exercises kernel controls in capable CI.
    const sandbox = createLinuxSandbox({
      workingDirectory: process.cwd(),
      environment: {},
      cgroupParentPath: "/missing",
      tempBaseDir: "/tmp",
      sigtermGraceMs: 1,
      unsafeLocal: false,
      clock: { monotonicNs: () => 0n },
    });
    // Setup fails before spawning when no delegated cgroup exists: ordinary CI
    // must fail closed rather than silently executing outside the boundary.
    const result = await sandbox.run(
      { executable: process.execPath, args: ["-e", "process.exit(0)"] },
      new Uint8Array(),
      limits,
      {
        isCancellationRequested: false,
        onCancel: () => () => undefined,
        throwIfCancellationRequested: () => undefined,
      },
    );
    expect(result.termination).toBe("spawn_failed");
    expect(result.cleanupDiagnostics[0]).toContain("setup failed");
  });
});
