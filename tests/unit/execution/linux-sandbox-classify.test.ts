/**
 * Unit tests for the pure termination-cause classifier.
 *
 * Each case crafts a {@link RawProcessResult} that exhibits exactly one (or a
 * deliberate combination of) failure signal(s) and asserts the classifier maps
 * it to the expected {@link TerminationCause}, including the cross-tier
 * precedence when several causes are present at once.
 */

import { describe, it, expect } from "vitest";
import { createResourceLimits } from "../../../src/domain/index.js";
import type {
  RawProcessResult,
  ResourceLimits,
} from "../../../src/domain/index.js";
import { classifyTermination } from "../../../src/execution/classify.js";

const LIMITS: ResourceLimits = createResourceLimits({
  wallTimeMs: 2000,
  cpuTimeMs: 1500,
  memoryBytes: 256 * 1024 * 1024,
  stdoutBytes: 1024 * 1024,
  stderrBytes: 1024 * 1024,
  combinedOutputBytes: 4 * 1024 * 1024,
  inputBytes: 16 * 1024 * 1024,
  fileSizeBytes: 16 * 1024 * 1024,
  processCount: 32,
  openDescriptors: 64,
  tempStorageBytes: 64 * 1024 * 1024,
  concurrencyPerCase: 1,
});

/** Build a clean, in-limit raw result, overriding the fields under test. */
function makeRaw(overrides: Partial<RawProcessResult> = {}): RawProcessResult {
  return {
    termination: "exited",
    exitCode: 0,
    signal: null,
    stdout: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
    stderr: { data: new Uint8Array(), truncated: false, totalBytes: 0 },
    resources: {
      wallTimeMs: 10,
      cpuTimeMs: 5,
      memoryPeakBytes: 1024,
      oomKills: 0,
      peakProcessCount: 1,
    },
    cleanupDiagnostics: [],
    ...overrides,
  };
}

describe("classifyTermination", () => {
  it("classifies a clean in-limit exit as passed", () => {
    expect(classifyTermination(makeRaw(), LIMITS)).toBe("passed");
  });

  it("classifies a nonzero exit", () => {
    expect(classifyTermination(makeRaw({ exitCode: 1 }), LIMITS)).toBe(
      "nonzero_exit",
    );
  });

  it("classifies a terminating signal as signaled", () => {
    expect(
      classifyTermination(
        makeRaw({ termination: "signaled", exitCode: null, signal: "SIGSEGV" }),
        LIMITS,
      ),
    ).toBe("signaled");
  });

  it("classifies a wall-deadline kill as tle_wall", () => {
    expect(
      classifyTermination(
        makeRaw({
          termination: "timed_out",
          exitCode: null,
          signal: "SIGKILL",
        }),
        LIMITS,
      ),
    ).toBe("tle_wall");
  });

  it("classifies a sampled wall overrun as tle_wall", () => {
    const raw = makeRaw({
      resources: { ...makeRaw().resources, wallTimeMs: LIMITS.wallTimeMs },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("tle_wall");
  });

  it("classifies SIGXCPU as tle_cpu", () => {
    expect(
      classifyTermination(
        makeRaw({ termination: "signaled", exitCode: null, signal: "SIGXCPU" }),
        LIMITS,
      ),
    ).toBe("tle_cpu");
  });

  it("classifies a sampled CPU overrun as tle_cpu", () => {
    const raw = makeRaw({
      resources: { ...makeRaw().resources, cpuTimeMs: LIMITS.cpuTimeMs },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("tle_cpu");
  });

  it("classifies an OOM kill as mle", () => {
    const raw = makeRaw({
      termination: "killed",
      resources: { ...makeRaw().resources, oomKills: 1 },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("mle");
  });

  it("classifies a memory peak at the ceiling as mle", () => {
    const raw = makeRaw({
      resources: {
        ...makeRaw().resources,
        memoryPeakBytes: LIMITS.memoryBytes,
      },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("mle");
  });

  it("classifies a truncated stream as output_limit", () => {
    const raw = makeRaw({
      stdout: {
        data: new Uint8Array(LIMITS.stdoutBytes),
        truncated: true,
        totalBytes: LIMITS.stdoutBytes + 1,
      },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("output_limit");
  });

  it("classifies a combined-output overflow as output_limit", () => {
    const half = Math.ceil(LIMITS.combinedOutputBytes / 2) + 1;
    const raw = makeRaw({
      stdout: { data: new Uint8Array(), truncated: false, totalBytes: half },
      stderr: { data: new Uint8Array(), truncated: false, totalBytes: half },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("output_limit");
  });

  it("classifies SIGXFSZ as file_limit", () => {
    expect(
      classifyTermination(
        makeRaw({ termination: "signaled", exitCode: null, signal: "SIGXFSZ" }),
        LIMITS,
      ),
    ).toBe("file_limit");
  });

  it("classifies a process-count breach as process_limit", () => {
    const raw = makeRaw({
      resources: {
        ...makeRaw().resources,
        peakProcessCount: LIMITS.processCount,
      },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("process_limit");
  });

  it("classifies a spawn failure as spawn_error (fail closed)", () => {
    expect(
      classifyTermination(
        makeRaw({ termination: "spawn_failed", exitCode: null }),
        LIMITS,
      ),
    ).toBe("spawn_error");
  });

  it("prefers a resource cause over a signal (precedence)", () => {
    // An OOM-killed process is delivered SIGKILL; mle (tier 1) outranks
    // signaled (tier 3).
    const raw = makeRaw({
      termination: "killed",
      exitCode: null,
      signal: "SIGKILL",
      resources: { ...makeRaw().resources, oomKills: 1 },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("mle");
  });

  it("prefers output_limit over a nonzero exit (precedence)", () => {
    const raw = makeRaw({
      exitCode: 1,
      stdout: {
        data: new Uint8Array(LIMITS.stdoutBytes),
        truncated: true,
        totalBytes: LIMITS.stdoutBytes + 100,
      },
    });
    expect(classifyTermination(raw, LIMITS)).toBe("output_limit");
  });
});
