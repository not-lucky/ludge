import { describe, it, expect } from "vitest";
import { createResourceLimits } from "../../../src/domain/limits.js";
import type {
  ResourceLimits,
  ResourceLimitsSpec,
} from "../../../src/domain/limits.js";
import {
  toRunId,
  toCaseId,
  initialGeneration,
} from "../../../src/domain/ids.js";
import type {
  ExecutionRequest,
  RawProcessResult,
  BoundedOutput,
} from "../../../src/domain/execution.js";
import type {
  ComparisonPolicy,
  ComparisonResult,
} from "../../../src/domain/comparison.js";

/** A fully valid spec: every field a positive safe integer. */
function validSpec(): ResourceLimitsSpec {
  return {
    wallTimeMs: 2000,
    cpuTimeMs: 1000,
    memoryBytes: 268_435_456,
    stdoutBytes: 65_536,
    stderrBytes: 65_536,
    combinedOutputBytes: 131_072,
    inputBytes: 4096,
    fileSizeBytes: 1_048_576,
    processCount: 16,
    openDescriptors: 64,
    tempStorageBytes: 10_485_760,
    concurrencyPerCase: 4,
  };
}

const LIMIT_FIELDS: readonly (keyof ResourceLimits)[] = [
  "wallTimeMs",
  "cpuTimeMs",
  "memoryBytes",
  "stdoutBytes",
  "stderrBytes",
  "combinedOutputBytes",
  "inputBytes",
  "fileSizeBytes",
  "processCount",
  "openDescriptors",
  "tempStorageBytes",
  "concurrencyPerCase",
];

describe("createResourceLimits", () => {
  it("returns a value whose fields equal the input spec", () => {
    const spec = validSpec();
    const limits = createResourceLimits(spec);
    for (const field of LIMIT_FIELDS) {
      expect(limits[field]).toBe(spec[field]);
    }
  });

  it("returns a frozen object", () => {
    const limits = createResourceLimits(validSpec());
    expect(Object.isFrozen(limits)).toBe(true);
  });

  it("throws when mutating a field in strict mode", () => {
    "use strict";
    const limits = createResourceLimits(validSpec());
    expect(() => {
      // Reassigning a readonly, frozen field must throw in strict mode.
      (limits as { wallTimeMs: number }).wallTimeMs = 5000;
    }).toThrow(TypeError);
  });

  // Per-field rejection matrix: corrupt exactly one field at a time.
  const badValues: readonly [label: string, value: number][] = [
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];

  const cases = LIMIT_FIELDS.flatMap((field) =>
    badValues.map(
      ([label, value]) =>
        [field, label, value] as [keyof ResourceLimits, string, number],
    ),
  );

  it.each(cases)(
    "rejects field '%s' when it is %s",
    (field, _label, value) => {
      const spec = { ...validSpec(), [field]: value };
      let thrown: unknown;
      try {
        createResourceLimits(spec);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      // The message must name the offending field.
      expect((thrown as RangeError).message).toMatch(
        new RegExp(`'${field}'`),
      );
    },
  );
});

describe("toRunId / toCaseId", () => {
  it("returns the input string for non-empty input", () => {
    expect(toRunId("run-1")).toBe("run-1");
    expect(toCaseId("case-1")).toBe("case-1");
  });

  it("throws RangeError for the empty string", () => {
    expect(() => toRunId("")).toThrow(RangeError);
    expect(() => toCaseId("")).toThrow(RangeError);
  });
});

describe("execution & comparison contract shapes", () => {
  it("wires an ExecutionRequest together from its dependencies", () => {
    const limits = createResourceLimits(validSpec());
    const request = {
      runId: toRunId("r1"),
      caseId: toCaseId("c1"),
      problemFingerprint: "problem-abc",
      implementation: {
        role: "solution",
        relativePath: "solution.py",
      },
      inputBytes: new Uint8Array([1, 2, 3]),
      inputCodecVersion: "codec-v1",
      outputCodecVersion: "codec-v1",
      limits,
      generation: initialGeneration(),
    } satisfies ExecutionRequest;

    expect(request.runId).toBe("r1");
    expect(request.caseId).toBe("c1");
    expect(request.implementation.role).toBe("solution");
    expect(Array.from(request.inputBytes)).toEqual([1, 2, 3]);
    expect(request.limits.wallTimeMs).toBe(2000);
    expect(request.generation).toBe(0);
  });

  it("constructs a RawProcessResult with bounded outputs", () => {
    const stdout = {
      data: new Uint8Array([65]),
      truncated: false,
      totalBytes: 1,
    } satisfies BoundedOutput;

    const result = {
      termination: "exited",
      exitCode: 0,
      signal: null,
      stdout,
      stderr: {
        data: new Uint8Array(),
        truncated: false,
        totalBytes: 0,
      },
      resources: {
        wallTimeMs: 12,
        cpuTimeMs: 8,
        memoryPeakBytes: 1024,
        oomKills: 0,
        peakProcessCount: 1,
      },
      cleanupDiagnostics: [],
    } satisfies RawProcessResult;

    expect(result.termination).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.truncated).toBe(false);
    expect(result.stdout.totalBytes).toBe(1);
    expect(result.resources.oomKills).toBe(0);
    expect(result.cleanupDiagnostics).toEqual([]);
  });

  it("constructs a ComparisonPolicy", () => {
    const policy = {
      version: "exact-v1",
      equality: "semantic",
      normalizeWhitespace: false,
      tolerance: { absolute: 1e-9, relative: 1e-6 },
    } satisfies ComparisonPolicy;

    expect(policy.version).toBe("exact-v1");
    expect(policy.equality).toBe("semantic");
    expect(policy.normalizeWhitespace).toBe(false);
    expect(policy.tolerance?.absolute).toBe(1e-9);
  });

  it("constructs the equal ComparisonResult variant", () => {
    const result = { equal: true } satisfies ComparisonResult;
    expect(result.equal).toBe(true);
  });

  it("constructs the unequal ComparisonResult variant with a mismatch", () => {
    const result = {
      equal: false,
      mismatch: {
        path: "$.items[3].value",
        reason: "numeric leaves differ",
        expected: "42",
        actual: "43",
      },
    } satisfies ComparisonResult;

    expect(result.equal).toBe(false);
    // Narrow on the discriminant before touching the mismatch payload.
    if (result.equal === false) {
      expect(typeof result.mismatch.path).toBe("string");
      expect(typeof result.mismatch.reason).toBe("string");
      expect(typeof result.mismatch.expected).toBe("string");
      expect(typeof result.mismatch.actual).toBe("string");
      expect(result.mismatch.path).toBe("$.items[3].value");
      expect(result.mismatch.expected).toBe("42");
      expect(result.mismatch.actual).toBe("43");
    }
  });
});
