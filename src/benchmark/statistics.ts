/**
 * Pure, integer-only benchmark statistics and baseline pairing policy.
 *
 * Durations and memory are represented by bigint to preserve nanosecond and
 * byte values above `Number.MAX_SAFE_INTEGER`. Percentiles use the inclusive
 * nearest-rank rule: rank is `ceil(percentile * count / 100)`, with rank zero
 * mapped to the first observation. Thus all selected values are observations,
 * never floating-point interpolations.
 */

/** Outcome label retained with every measured sample; outliers are never trimmed. */
export type IqrOutlierLabel = "none" | "lower" | "upper";

/** Input needed to include a sample in a per-case aggregate. */
export interface BenchmarkStatisticSample {
  /** True for a discarded warmup. */
  readonly warmup: boolean;
  /** Only successful, fully decoded samples are valid measurement observations. */
  readonly valid: boolean;
  /** Target phase duration, required for valid samples. */
  readonly targetNs: bigint | null;
  /** Cgroup peak memory, if the platform reported it. */
  readonly peakMemoryBytes: bigint | null;
}

/** Integer timing distribution plus valid/failure denominators. */
export interface BenchmarkStatistics {
  /** Measured samples, including failed/censored samples but excluding warmups. */
  readonly count: number;
  /** Successful measured samples included in timing statistics. */
  readonly validCount: number;
  /** Failed or censored measured samples, excluded from distributions. */
  readonly failedCount: number;
  readonly minNs: bigint | null;
  readonly medianNs: bigint | null;
  readonly p90Ns: bigint | null;
  readonly p95Ns: bigint | null;
  readonly p99Ns: bigint | null;
  readonly maxNs: bigint | null;
  /** Arithmetic mean, truncated toward zero to the storage integer unit. */
  readonly meanNs: bigint | null;
  /** Population standard deviation, floored to the storage integer unit. */
  readonly stddevNs: bigint | null;
  readonly memoryMedianBytes: bigint | null;
  readonly memoryP95Bytes: bigint | null;
  readonly memoryMaxBytes: bigint | null;
}

/** A sample coordinate used to align a candidate with the fixed baseline. */
export interface PairedBenchmarkSample {
  readonly caseOrdinal: number;
  /** Global per-case benchmark ordinal; warmups and measurements never collide. */
  readonly ordinal: number;
  readonly warmup: boolean;
  readonly valid: boolean;
  readonly targetNs: bigint | null;
}

/** Exact relative change, where `numerator / denominator` is the ratio. */
export interface ExactRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Baseline/candidate result calculated only from aligned successful measurements. */
export interface PairedBaselineDelta {
  readonly pairCount: number;
  /** Inclusive-rank median of `candidate - baseline` target durations. */
  readonly medianDeltaNs: bigint | null;
  /** Inclusive-rank median baseline duration across the aligned pairs. */
  readonly baselineMedianNs: bigint | null;
  /** `medianDeltaNs / baselineMedianNs`, or null when no meaningful denominator exists. */
  readonly relativeDelta: ExactRatio | null;
}

/**
 * Select an inclusive nearest-rank percentile without converting bigint values
 * to number. `percentile` is an integral percentage in the inclusive 0..100
 * range; benchmark callers use 50, 90, 95, and 99.
 */
export function inclusiveRank(
  values: readonly bigint[],
  percentile: number,
): bigint | null {
  assertPercentile(percentile);
  if (values.length === 0) return null;
  const ordered = [...values].sort(compareBigint);
  return ordered[inclusiveRankIndex(ordered.length, percentile)]!;
}

/** Calculate aggregate timing and memory statistics from measured samples only. */
export function calculateBenchmarkStatistics(
  samples: readonly BenchmarkStatisticSample[],
): BenchmarkStatistics {
  const measured = samples.filter((sample) => !sample.warmup);
  const valid = measured.filter((sample) => sample.valid);
  for (const sample of valid) {
    if (sample.targetNs === null || sample.targetNs < 0n) {
      throw new RangeError(
        "A valid benchmark sample requires a non-negative target duration.",
      );
    }
    if (sample.peakMemoryBytes !== null && sample.peakMemoryBytes < 0n) {
      throw new RangeError("Peak memory cannot be negative.");
    }
  }

  const durations = valid.map((sample) => sample.targetNs!);
  const memory = valid.flatMap((sample) =>
    sample.peakMemoryBytes === null ? [] : [sample.peakMemoryBytes],
  );
  return Object.freeze({
    count: measured.length,
    validCount: valid.length,
    failedCount: measured.length - valid.length,
    minNs: inclusiveRank(durations, 0),
    medianNs: inclusiveRank(durations, 50),
    p90Ns: inclusiveRank(durations, 90),
    p95Ns: inclusiveRank(durations, 95),
    p99Ns: inclusiveRank(durations, 99),
    maxNs: inclusiveRank(durations, 100),
    meanNs: integerMean(durations),
    stddevNs: populationStandardDeviation(durations),
    memoryMedianBytes: inclusiveRank(memory, 50),
    memoryP95Bytes: inclusiveRank(memory, 95),
    memoryMaxBytes: inclusiveRank(memory, 100),
  });
}

/**
 * Label target-duration outliers with Tukey's 1.5 IQR fences.
 *
 * Input values are normally the valid non-warmup target durations for one
 * implementation/case series. The returned labels have matching positions.
 */
export function labelIqrOutliers(
  values: readonly bigint[],
): readonly IqrOutlierLabel[] {
  if (values.some((value) => value < 0n))
    throw new RangeError("Durations cannot be negative.");
  if (values.length === 0) return Object.freeze([]);

  const firstQuartile = inclusiveRank(values, 25)!;
  const thirdQuartile = inclusiveRank(values, 75)!;
  const iqr = thirdQuartile - firstQuartile;
  const lowerTwice = 2n * firstQuartile - 3n * iqr;
  const upperTwice = 2n * thirdQuartile + 3n * iqr;
  return Object.freeze(
    values.map((value) => {
      if (2n * value < lowerTwice) return "lower";
      if (2n * value > upperTwice) return "upper";
      return "none";
    }),
  );
}

/**
 * Calculate candidate-minus-baseline deltas from matching `(caseOrdinal,
 * ordinal)` successful non-warmup samples. Missing/failed sides do not form a
 * pair. Duplicate coordinates are rejected rather than silently overwritten.
 */
export function calculatePairedBaselineDelta(
  baseline: readonly PairedBenchmarkSample[],
  candidate: readonly PairedBenchmarkSample[],
): PairedBaselineDelta {
  const baselineByCoordinate = successfulMeasuredByCoordinate(
    baseline,
    "baseline",
  );
  const candidateByCoordinate = successfulMeasuredByCoordinate(
    candidate,
    "candidate",
  );
  const deltas: bigint[] = [];
  const baselineDurations: bigint[] = [];

  for (const [coordinate, candidateDuration] of candidateByCoordinate) {
    const baselineDuration = baselineByCoordinate.get(coordinate);
    if (baselineDuration === undefined) continue;
    deltas.push(candidateDuration - baselineDuration);
    baselineDurations.push(baselineDuration);
  }

  const medianDeltaNs = inclusiveRank(deltas, 50);
  const baselineMedianNs = inclusiveRank(baselineDurations, 50);
  const relativeDelta =
    medianDeltaNs === null ||
    baselineMedianNs === null ||
    baselineMedianNs === 0n
      ? null
      : Object.freeze({
          numerator: medianDeltaNs,
          denominator: baselineMedianNs,
        });
  return Object.freeze({
    pairCount: deltas.length,
    medianDeltaNs,
    baselineMedianNs,
    relativeDelta,
  });
}

function successfulMeasuredByCoordinate(
  samples: readonly PairedBenchmarkSample[],
  side: string,
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const sample of samples) {
    assertCoordinate(sample.caseOrdinal, "caseOrdinal");
    assertCoordinate(sample.ordinal, "ordinal");
    if (sample.warmup || !sample.valid) continue;
    if (sample.targetNs === null || sample.targetNs < 0n) {
      throw new RangeError(
        `A valid ${side} paired sample requires a non-negative target duration.`,
      );
    }
    const coordinate = `${sample.caseOrdinal}:${sample.ordinal}`;
    if (result.has(coordinate))
      throw new RangeError(
        `Duplicate ${side} paired sample coordinate: ${coordinate}.`,
      );
    result.set(coordinate, sample.targetNs);
  }
  return result;
}

function integerMean(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  return sum(values) / BigInt(values.length);
}

function populationStandardDeviation(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const count = BigInt(values.length);
  const total = sum(values);
  const sumSquares = values.reduce(
    (accumulator, value) => accumulator + value * value,
    0n,
  );
  // sqrt((n * sum(x²) - sum(x)²) / n²), held as one exact integer division.
  return integerSquareRoot(
    (count * sumSquares - total * total) / (count * count),
  );
}

function inclusiveRankIndex(count: number, percentile: number): number {
  if (percentile === 0) return 0;
  return Math.ceil((count * percentile) / 100) - 1;
}

function integerSquareRoot(value: bigint): bigint {
  if (value < 0n)
    throw new RangeError(
      "Cannot calculate the square root of a negative value.",
    );
  if (value < 2n) return value;
  let lower = 1n;
  let upper = value;
  while (lower + 1n < upper) {
    const middle = (lower + upper) >> 1n;
    if (middle <= value / middle) lower = middle;
    else upper = middle;
  }
  return lower;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((accumulator, value) => accumulator + value, 0n);
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPercentile(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError(
      "Percentile must be an integer in the inclusive range 0..100.",
    );
  }
}

function assertCoordinate(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}
