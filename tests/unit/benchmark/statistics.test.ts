import { describe, expect, it } from "vitest";

import {
  calculateBenchmarkStatistics,
  calculatePairedBaselineDelta,
  inclusiveRank,
  labelIqrOutliers,
} from "../../../src/benchmark/statistics.js";

describe("inclusive BigInt benchmark statistics", () => {
  it("uses inclusive nearest rank and preserves bigint values beyond Number.MAX_SAFE_INTEGER", () => {
    const base = 9_007_199_254_740_992n;
    const values = [base + 5n, base + 1n, base + 9n, base + 3n, base + 7n];

    expect(inclusiveRank(values, 0)).toBe(base + 1n);
    expect(inclusiveRank(values, 50)).toBe(base + 5n);
    expect(inclusiveRank(values, 90)).toBe(base + 9n);
    expect(inclusiveRank(values, 95)).toBe(base + 9n);
    expect(inclusiveRank(values, 99)).toBe(base + 9n);
    expect(inclusiveRank(values, 100)).toBe(base + 9n);
  });

  it("excludes warmups and censored failures from distributions but retains their denominators", () => {
    const result = calculateBenchmarkStatistics([
      { warmup: true, valid: true, targetNs: 1n, peakMemoryBytes: 1n },
      { warmup: false, valid: true, targetNs: 10n, peakMemoryBytes: 100n },
      { warmup: false, valid: false, targetNs: null, peakMemoryBytes: null },
      { warmup: false, valid: true, targetNs: 30n, peakMemoryBytes: 300n },
    ]);

    expect(result).toMatchObject({
      count: 3,
      validCount: 2,
      failedCount: 1,
      minNs: 10n,
      medianNs: 10n,
      p90Ns: 30n,
      p95Ns: 30n,
      p99Ns: 30n,
      maxNs: 30n,
      meanNs: 20n,
      stddevNs: 10n,
      memoryMedianBytes: 100n,
      memoryP95Bytes: 300n,
      memoryMaxBytes: 300n,
    });
  });

  it("returns null statistics rather than fabricated zeroes when no measured sample is valid", () => {
    const result = calculateBenchmarkStatistics([
      { warmup: true, valid: true, targetNs: 12n, peakMemoryBytes: 8n },
      { warmup: false, valid: false, targetNs: null, peakMemoryBytes: null },
      { warmup: false, valid: false, targetNs: null, peakMemoryBytes: null },
    ]);

    expect(result).toEqual({
      count: 2,
      validCount: 0,
      failedCount: 2,
      minNs: null,
      medianNs: null,
      p90Ns: null,
      p95Ns: null,
      p99Ns: null,
      maxNs: null,
      meanNs: null,
      stddevNs: null,
      memoryMedianBytes: null,
      memoryP95Bytes: null,
      memoryMaxBytes: null,
    });
  });

  it("labels Tukey IQR outliers without removing them", () => {
    const durations = [10n, 10n, 11n, 11n, 12n, 12n, 100n];
    expect(labelIqrOutliers(durations)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
      "upper",
    ]);
    expect(labelIqrOutliers([])).toEqual([]);
  });
});

describe("paired baseline deltas", () => {
  it("aligns only valid non-warmup samples by case and ordinal", () => {
    const result = calculatePairedBaselineDelta(
      [
        { caseOrdinal: 0, ordinal: 0, warmup: true, valid: true, targetNs: 1n },
        {
          caseOrdinal: 0,
          ordinal: 1,
          warmup: false,
          valid: true,
          targetNs: 100n,
        },
        {
          caseOrdinal: 0,
          ordinal: 2,
          warmup: false,
          valid: true,
          targetNs: 200n,
        },
        {
          caseOrdinal: 1,
          ordinal: 1,
          warmup: false,
          valid: false,
          targetNs: null,
        },
      ],
      [
        { caseOrdinal: 0, ordinal: 0, warmup: true, valid: true, targetNs: 2n },
        {
          caseOrdinal: 0,
          ordinal: 1,
          warmup: false,
          valid: true,
          targetNs: 130n,
        },
        {
          caseOrdinal: 0,
          ordinal: 2,
          warmup: false,
          valid: false,
          targetNs: null,
        },
        {
          caseOrdinal: 1,
          ordinal: 1,
          warmup: false,
          valid: true,
          targetNs: 400n,
        },
      ],
    );

    expect(result).toEqual({
      pairCount: 1,
      medianDeltaNs: 30n,
      baselineMedianNs: 100n,
      relativeDelta: { numerator: 30n, denominator: 100n },
    });
  });

  it("does not invent a relative delta when aligned baseline median is zero or no pair exists", () => {
    expect(
      calculatePairedBaselineDelta(
        [
          {
            caseOrdinal: 0,
            ordinal: 0,
            warmup: false,
            valid: true,
            targetNs: 0n,
          },
        ],
        [
          {
            caseOrdinal: 0,
            ordinal: 0,
            warmup: false,
            valid: true,
            targetNs: 5n,
          },
        ],
      ),
    ).toEqual({
      pairCount: 1,
      medianDeltaNs: 5n,
      baselineMedianNs: 0n,
      relativeDelta: null,
    });

    expect(
      calculatePairedBaselineDelta(
        [
          {
            caseOrdinal: 0,
            ordinal: 0,
            warmup: false,
            valid: false,
            targetNs: null,
          },
        ],
        [
          {
            caseOrdinal: 0,
            ordinal: 0,
            warmup: false,
            valid: true,
            targetNs: 5n,
          },
        ],
      ),
    ).toEqual({
      pairCount: 0,
      medianDeltaNs: null,
      baselineMedianNs: null,
      relativeDelta: null,
    });
  });
});
