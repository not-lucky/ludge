import type { Generation, RunId } from "./ids.js";
import type { ResourceLimits } from "./limits.js";
import type { ExecutionStatus } from "./status.js";

export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "canceling"
  | "completed"
  | "failed"
  | "canceled";
export type TerminalRunState = "completed" | "failed" | "canceled";

export interface RunQuery {
  readonly slug?: string;
  readonly since?: string;
  readonly status?: ExecutionStatus;
  readonly limit?: number;
}

/** Persisted benchmark plan/comparability metadata, absent on non-benchmark runs. */
export interface BenchmarkRunMetadata {
  /** Version of the fixed benchmark lifecycle and statistic methodology. */
  readonly methodologyVersion: string;
  /** Discarded warmups per implementation/case. */
  readonly warmups: number;
  /** Measured samples per implementation/case. */
  readonly sampleCount: number;
  /** Canonical decimal uint64 sample-order seed. */
  readonly orderSeed: string;
  /** SHA-256 of the ordered explicit implementation source plan. */
  readonly planSha256: string;
  /** Whether controls/fingerprints permit timing deltas. */
  readonly comparable: boolean;
  /** Required reason when `comparable` is false. */
  readonly comparabilityReason: string | null;
  /** Linked environment snapshot identity. */
  readonly environmentId: string;
}

/**
 * A durable snapshot of one completed run (a Memento).
 *
 * It captures everything required to report and replay the run deterministically:
 * the seed, limits, codec/comparator versions, content hashes, generation, and
 * timing. All fields are immutable.
 */
export interface PersistableRun {
  /** Identity of the run. */
  readonly runId: RunId;
  /** Problem slug the run targeted. */
  readonly slug: string;
  /** The terminal lifecycle state. */
  readonly state: TerminalRunState;
  /** The normalized execution status (verdict). */
  readonly status: ExecutionStatus;
  /** Stable fingerprint of the problem/config the run was computed against. */
  readonly problemFingerprint: string;
  /** Seed used for generation/replay, or `null` for fixed-case runs. */
  readonly seed: string | null;
  /** Resource limits the run executed under. */
  readonly limits: ResourceLimits;
  /** Version of the input codec used. */
  readonly inputCodecVersion: string;
  /** Version of the output codec used. */
  readonly outputCodecVersion: string;
  /** Version of the comparison policy applied. */
  readonly comparisonPolicyVersion: string;
  /** Content hash of the encoded input. */
  readonly inputHash: string;
  /** Content hash of the encoded output, or `null` when none was produced. */
  readonly outputHash: string | null;
  /** Watch generation the run belonged to. */
  readonly generation: Generation;
  /** Wall-clock start time as ISO-8601 UTC text. */
  readonly wallTimeUtc: string;
  /** Measured run duration in milliseconds. */
  readonly durationMs: number;
  /** Benchmark methodology/comparability facts, absent for ordinary runs. */
  readonly benchmark?: BenchmarkRunMetadata;
}
