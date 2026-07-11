/**
 * TypeScript row interfaces mirroring the exact SQLite schema columns.
 *
 * Each interface is a faithful 1:1 image of one table's columns, so the mappers
 * and repositories are type-checked against the real column set rather than an
 * ad-hoc bag of fields. The column conventions from
 * `docs/storage/sqlite-metrics.md` are encoded directly in the field types:
 *
 * - Timestamps are UTC ISO-8601 `string`s (with a `Z` offset).
 * - Nanosecond durations are `bigint` (SQLite `INTEGER` is 64-bit signed, so a
 *   `number` would silently lose precision beyond 2^53).
 * - Byte counts are `bigint` for the same reason.
 * - Content hashes are lowercase SHA-256 `string`s.
 * - `null` means *unavailable / not applicable*; `0` (or `0n`) means a measured
 *   zero — the two are never conflated.
 * - Booleans are stored as `0 | 1`, nullable where the value can be unknown.
 * - Unsigned 64-bit seeds are canonical decimal **text** (`"0"` through
 *   `"18446744073709551615"`) because a signed SQLite `INTEGER` cannot hold the
 *   full unsigned range.
 *
 * This module declares only shapes; it imports nothing and holds no runtime.
 */

import type { PersistenceRecords } from "../ports/index.js";

/** A stored boolean: `1` true, `0` false, `null` unknown/not applicable. */
export type SqliteBool = 0 | 1 | null;

/** Row of the `problem` table. */
export interface ProblemRow {
  /** Stable problem identity (PK). */
  readonly problem_id: string;
  /** Unique human-facing slug. */
  readonly slug: string;
  /** `problem.yaml` schema version the registration was validated against. */
  readonly schema_version: number;
  /** Human-readable title. */
  readonly title: string;
  /** Registration timestamp (UTC ISO-8601). */
  readonly created_at: string;
  /** Last-update timestamp (UTC ISO-8601). */
  readonly updated_at: string;
}

/** Row of the `implementation` table. */
export interface ImplementationRow {
  /** Stable implementation identity (PK). */
  readonly implementation_id: string;
  /** Owning problem (FK -> problem, RESTRICT). */
  readonly problem_id: string;
  /** Path to the implementation source, relative to the problem root. */
  readonly path: string;
  /** Role played in the run (e.g. `solution`, `naive`, `generator`). */
  readonly role: string;
  /** Lowercase SHA-256 of the implementation's content. */
  readonly content_sha256: string;
  /** Runtime identifier used to execute it (e.g. `python-uv`). */
  readonly runtime: string;
  /** Registration timestamp (UTC ISO-8601). */
  readonly created_at: string;
}

/**
 * Row of the `run` table.
 *
 * A run row is the storage image of the {@link import("../../domain/index.js").PersistableRun}
 * Memento *plus* the orchestration columns the spec names (command, environment,
 * benchmark plan). The Memento fields are always present; the orchestration
 * columns are `null` until a command producer (tasks 12-16) fills them, so a
 * bare run round-trips through the {@link RunRepository} without inventing data.
 *
 * `problem_id` and `environment_id` are nullable foreign keys: the Memento
 * carries a `slug`, not a problem identity, so a run can be persisted and
 * round-tripped before (or without) a matching `problem`/`environment` row. When
 * they are set, the `ON DELETE RESTRICT` rule still protects the reference.
 */
export interface RunRow {
  /** Run identity (PK). */
  readonly run_id: string;
  /** Owning problem (FK -> problem, RESTRICT), or `null` when not linked. */
  readonly problem_id: string | null;
  /** Problem slug the run targeted (from the Memento). */
  readonly slug: string;
  /** Command that produced the run (`test`, `stress-test`, ...); `null` bare. */
  readonly command: string | null;
  /** Selected seed as canonical unsigned-64 decimal text, or `null`. */
  readonly seed: string | null;
  /** Terminal lifecycle state (`completed` | `failed` | `canceled`). */
  readonly state: string;
  /** Normalized execution status (the verdict). */
  readonly status: string;
  /** Stable fingerprint of the problem/config the run was computed against. */
  readonly problem_fingerprint: string;
  /** Version of the input codec used. */
  readonly input_codec_version: string;
  /** Version of the output codec used. */
  readonly output_codec_version: string;
  /** Version of the comparison policy applied. */
  readonly comparator_version: string;
  /** Benchmark methodology version, or `null` for non-benchmark runs. */
  readonly methodology_version: string | null;
  /** Lowercase SHA-256 of the encoded input. */
  readonly input_hash: string;
  /** Lowercase SHA-256 of the encoded output, or `null` when none produced. */
  readonly output_hash: string | null;
  /** Watch generation the run belonged to. */
  readonly generation: number;
  /** Wall-clock start time (UTC ISO-8601); the Memento's `wallTimeUtc`. */
  readonly started_at: string;
  /** Wall-clock finish time (UTC ISO-8601), or `null` when not recorded. */
  readonly finished_at: string | null;
  /** Measured run duration in milliseconds. */
  readonly duration_ms: number;
  /** Serialized {@link import("../../domain/index.js").ResourceLimits} (JSON). */
  readonly limits_json: string;
  /** Environment record (FK -> environment, RESTRICT), or `null`. */
  readonly environment_id: string | null;
  /** Non-negative benchmark warmup count, or `null` for non-benchmark runs. */
  readonly benchmark_warmups: number | null;
  /** Non-negative benchmark sample count, or `null` for non-benchmark runs. */
  readonly benchmark_sample_count: number | null;
  /** Benchmark ordering seed as unsigned-64 decimal text, or `null`. */
  readonly benchmark_order_seed: string | null;
  /** Comparability flag: `1` comparable, `0` non-comparable, `null` n/a. */
  readonly benchmark_comparability: SqliteBool;
  /** Reason string, required iff `benchmark_comparability` is `0`, else `null`. */
  readonly benchmark_comparability_reason: string | null;
}

/** Row of the `case` table. */
export interface CaseRow {
  /** Case identity (PK). */
  readonly case_id: string;
  /** Owning run (FK -> run, CASCADE). */
  readonly run_id: string;
  /** Zero-based position of the case within the run. */
  readonly ordinal: number;
  /** Lowercase SHA-256 of the encoded case input. */
  readonly input_sha256: string;
  /** Size of the encoded input in bytes. */
  readonly input_bytes: bigint;
  /** Normalized per-case status. */
  readonly status: string;
}

/** Row of the `execution` table. */
export interface ExecutionRow {
  /** Execution identity (PK). */
  readonly execution_id: string;
  /** Owning case (FK -> case, CASCADE). */
  readonly case_id: string;
  /** Implementation executed (FK -> implementation, RESTRICT). */
  readonly implementation_id: string;
  /** Normalized execution status. */
  readonly status: string;
  /** Process exit code, or `null` when it did not exit normally. */
  readonly exit_code: number | null;
  /** Terminating signal name, or `null` when not signaled. */
  readonly signal: string | null;
  /** Wall-clock duration in nanoseconds, or `null` when unmeasured. */
  readonly wall_ns: bigint | null;
  /** CPU time in nanoseconds, or `null` when unmeasured. */
  readonly cpu_ns: bigint | null;
  /** Peak memory in bytes, or `null` when unmeasured. */
  readonly peak_memory_bytes: bigint | null;
  /** Captured stdout size in bytes, or `null` when unmeasured. */
  readonly stdout_bytes: bigint | null;
  /** Captured stderr size in bytes, or `null` when unmeasured. */
  readonly stderr_bytes: bigint | null;
  /** Whether stdout capture was truncated (`0|1|null`). */
  readonly stdout_truncated: SqliteBool;
  /** Whether stderr capture was truncated (`0|1|null`). */
  readonly stderr_truncated: SqliteBool;
  /** Which limit terminated the process, or `null`. */
  readonly limit_cause: string | null;
  /** Bounded, versioned raw-result envelope (JSON), or `null` once pruned. */
  readonly raw_json: string | null;
}

/** Row of the `benchmark_sample` table. */
export interface BenchmarkSampleRow {
  /** Sample identity (PK). */
  readonly sample_id: string;
  /** Owning run (FK -> run, CASCADE). */
  readonly run_id: string;
  /** Case measured (FK -> case, CASCADE). */
  readonly case_id: string;
  /** Implementation measured (FK -> implementation, RESTRICT). */
  readonly implementation_id: string;
  /** Position of the sample within its measurement series. */
  readonly ordinal: number;
  /** Whether the sample was a warmup (`0|1`). */
  readonly warmup: SqliteBool;
  /** Normalized sample status. */
  readonly status: string;
  /** Setup phase duration in nanoseconds, or `null`. */
  readonly setup_ns: bigint | null;
  /** Measured target duration in nanoseconds, or `null`. */
  readonly target_ns: bigint | null;
  /** Total duration in nanoseconds, or `null`. */
  readonly total_ns: bigint | null;
  /** Peak memory in bytes, or `null`. */
  readonly peak_memory_bytes: bigint | null;
  /** Bounded, versioned raw sample envelope (JSON), or `null` once pruned. */
  readonly raw_json: string | null;
}

/** Row of the `benchmark_aggregate` table. All statistics are `null` when there are zero valid samples. */
export interface BenchmarkAggregateRow {
  /** Aggregate identity (PK). */
  readonly aggregate_id: string;
  /** Owning run (FK -> run, CASCADE). */
  readonly run_id: string;
  /** Implementation aggregated (FK -> implementation, RESTRICT). */
  readonly implementation_id: string;
  /** Case aggregated (FK -> case, CASCADE). */
  readonly case_id: string;
  /** Count of valid samples. */
  readonly valid_count: number;
  /** Count of failed samples. */
  readonly failed_count: number;
  /** Minimum target duration (ns), or `null` with zero valid samples. */
  readonly min_ns: bigint | null;
  /** Median target duration (ns), or `null`. */
  readonly median_ns: bigint | null;
  /** 90th-percentile target duration (ns), or `null`. */
  readonly p90_ns: bigint | null;
  /** 95th-percentile target duration (ns), or `null`. */
  readonly p95_ns: bigint | null;
  /** 99th-percentile target duration (ns), or `null`. */
  readonly p99_ns: bigint | null;
  /** Maximum target duration (ns), or `null`. */
  readonly max_ns: bigint | null;
  /** Mean target duration (ns), or `null`. */
  readonly mean_ns: bigint | null;
  /** Standard deviation of target duration (ns), or `null`. */
  readonly stddev_ns: bigint | null;
  /** Median peak memory (bytes), or `null`. */
  readonly memory_median_bytes: bigint | null;
  /** 95th-percentile peak memory (bytes), or `null`. */
  readonly memory_p95_bytes: bigint | null;
  /** Maximum peak memory (bytes), or `null`. */
  readonly memory_max_bytes: bigint | null;
}

/** Row of the `artifact` table. */
export interface ArtifactRow {
  /** Artifact identity (PK). */
  readonly artifact_id: string;
  /** Owning run (FK -> run, CASCADE). */
  readonly run_id: string;
  /** Artifact kind (e.g. `mismatch`, `fuzz-case`). */
  readonly kind: string;
  /** Path to the stored artifact content. */
  readonly path: string;
  /** Lowercase SHA-256 of the artifact content. */
  readonly sha256: string;
  /** Artifact size in bytes. */
  readonly size_bytes: bigint;
  /** Creation timestamp (UTC ISO-8601). */
  readonly created_at: string;
}

/** Row of the `environment` table. */
export interface EnvironmentRow {
  /** Environment identity (PK). */
  readonly environment_id: string;
  /** Fingerprint over all environment fields; any change breaks comparability. */
  readonly host_fingerprint: string;
  /** Kernel identification string. */
  readonly kernel: string;
  /** CPU model string. */
  readonly cpu_model: string;
  /** Python runtime version. */
  readonly python_version: string;
  /** `uv` version. */
  readonly uv_version: string;
  /** Node.js version. */
  readonly node_version: string;
  /** Sandbox enforcement mode label. */
  readonly sandbox_mode: string;
  /** Persistence mode label (e.g. `sqlite-wal-local`). */
  readonly database_mode: string;
  /** CPU governor, or `null` when unavailable. */
  readonly cpu_governor: string | null;
  /** CPU frequency label, or `null` when unavailable. */
  readonly cpu_frequency: string | null;
  /** Serialized resource limits (JSON) captured for the environment. */
  readonly limits_json: string;
}

/** Row of the `daily_metric` table (composite PK `(metric_date, problem_id)`). */
export interface DailyMetricRow {
  /** Calendar date (UTC `YYYY-MM-DD`). */
  readonly metric_date: string;
  /** Problem the metrics roll up (FK -> problem, RESTRICT). */
  readonly problem_id: string;
  /** Non-negative attempt count. */
  readonly attempts: number;
  /** Non-negative pass count. */
  readonly passes: number;
  /** Non-negative failure count. */
  readonly failures: number;
  /** Total wall time in nanoseconds. */
  readonly wall_ns: bigint;
  /** First-solved timestamp (UTC ISO-8601), or `null` when unsolved. */
  readonly solved_at: string | null;
}

/**
 * The concrete {@link PersistenceRecords} instantiation for the SQLite adapter.
 *
 * This refines every generic slot the ports left as `unknown`, so the
 * repositories and transaction scope are type-checked against real column
 * shapes. It is the type the composition root and the contract-test fixtures
 * instantiate the store at.
 */
export interface SqlitePersistenceRecords extends PersistenceRecords {
  /** Problem records are {@link ProblemRow}s. */
  readonly problem: ProblemRow;
  /** Per-sample benchmark records are {@link BenchmarkSampleRow}s. */
  readonly benchmarkSample: BenchmarkSampleRow;
  /** Aggregated benchmark records are {@link BenchmarkAggregateRow}s. */
  readonly benchmarkAggregate: BenchmarkAggregateRow;
  /** Daily metric records are {@link DailyMetricRow}s. */
  readonly metric: DailyMetricRow;
}
