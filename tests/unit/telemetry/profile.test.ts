import { describe, expect, it } from "vitest";
import type { RawProcessResult } from "../../../src/domain/index.js";
import type { Clock } from "../../../src/execution/clock.js";
import { createExecutionProfiler } from "../../../src/telemetry/index.js";

const clock: Clock = {
  monotonicNs: () => 10n,
  wallTimeUtc: () => "2026-01-01T00:00:00.000Z",
};

const raw: RawProcessResult = {
  termination: "exited",
  exitCode: 0,
  signal: null,
  stdout: { data: new Uint8Array(), totalBytes: 0, truncated: false },
  stderr: { data: new Uint8Array(), totalBytes: 12, truncated: true },
  resources: {
    wallTimeMs: 0,
    cpuTimeMs: 0,
    memoryPeakBytes: 0,
    oomKills: 0,
    peakProcessCount: 0,
  },
  cleanupDiagnostics: [],
};

describe("createExecutionProfiler", () => {
  it("preserves measured zero and represents unavailable fields as null", () => {
    const profiler = createExecutionProfiler(clock, {
      status: "passed",
      limitCause: null,
    });
    const profile = profiler.begin().finish(raw);

    expect(profile.wallDurationNs).toBe(0);
    expect(profile.cpuTotalNs).toBe(0);
    expect(profile.peakCgroupBytes).toBe(0);
    expect(profile.cgroupEvents.oomKills).toBe(0);
    expect(profile.cpuUserNs).toBeNull();
    expect(profile.spawnDurationNs).toBeNull();
    expect(profile.childPid).toBeNull();
    expect(profile.status).toBe("passed");
  });
});
