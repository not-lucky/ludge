/**
 * Pure domain ↔ row translation and shared column conventions.
 *
 * Everything here is side-effect-free and independently unit-testable: it never
 * touches a connection. The module owns the run Memento mapping
 * ({@link runToRow} / {@link rowToRun}), the query → parameterized `WHERE`
 * builder, and the low-level encoders/decoders every repository shares —
 * nullable columns, `bigint` nanoseconds, unsigned-64 seed decimal text, and
 * the `limits_json` serialization. All SQL is built with bound parameters, never
 * string interpolation, so untrusted values can never alter a statement.
 *
 * This is an adapter module; it imports the pure domain layer and no driver.
 */

import type {
  Generation,
  PersistableRun,
  ResourceLimits,
  RunQuery,
  TerminalRunState,
} from "../../domain/index.js";
import { createResourceLimits, toRunId } from "../../domain/index.js";
import type { ExecutionStatus } from "../../domain/index.js";
import type { SqlParams, SqliteRow } from "./connection.js";
import type { RunRow, SqliteBool } from "./rows.js";

/** The maximum unsigned 64-bit value a seed column may hold. */
export const MAX_U64_SEED = 18446744073709551615n;

/** Canonical unsigned-64 decimal: no sign, no leading zeros (except "0"). */
const U64_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

// --- shared column readers ------------------------------------------------

/**
 * Read a required text column.
 *
 * @param row - The raw row.
 * @param name - The column name.
 * @throws {TypeError} If the column is absent or not text.
 */
export function textCol(row: SqliteRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(
      `expected text column '${name}', got ${typeName(value)}`,
    );
  }
  return value;
}

/** Read a nullable text column (`null` when SQL `NULL`). */
export function nullableTextCol(row: SqliteRow, name: string): string | null {
  const value = row[name];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `expected text column '${name}', got ${typeName(value)}`,
    );
  }
  return value;
}

/** Read a required integer column as a JS `number` (small values only). */
export function intCol(row: SqliteRow, name: string): number {
  const value = row[name];
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  throw new TypeError(
    `expected integer column '${name}', got ${typeName(value)}`,
  );
}

/** Read a nullable integer column as `number | null`. */
export function nullableIntCol(row: SqliteRow, name: string): number | null {
  const value = row[name];
  if (value === null || value === undefined) {
    return null;
  }
  return intCol(row, name);
}

/** Read a required 64-bit integer column as a `bigint` (exact). */
export function bigIntCol(row: SqliteRow, name: string): bigint {
  const value = row[name];
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  throw new TypeError(
    `expected integer column '${name}', got ${typeName(value)}`,
  );
}

/** Read a nullable 64-bit integer column as `bigint | null`. */
export function nullableBigIntCol(row: SqliteRow, name: string): bigint | null {
  const value = row[name];
  if (value === null || value === undefined) {
    return null;
  }
  return bigIntCol(row, name);
}

/** Read a nullable stored boolean (`0 | 1 | null`). */
export function boolCol(row: SqliteRow, name: string): SqliteBool {
  const value = row[name];
  if (value === null || value === undefined) {
    return null;
  }
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  if (asNumber === 0) {
    return 0;
  }
  if (asNumber === 1) {
    return 1;
  }
  throw new TypeError(
    `expected boolean column '${name}' in {0,1,null}, got ${String(value)}`,
  );
}

/** Human-readable type name for error messages. */
function typeName(value: unknown): string {
  return value === null ? "null" : typeof value;
}

// --- seed encoding --------------------------------------------------------

/**
 * Validate and normalize a seed as unsigned-64 canonical decimal text.
 *
 * `null` (a run that uses no seed) passes through unchanged. A non-null seed
 * must be canonical decimal in `0 .. 18446744073709551615`.
 *
 * @param seed - The seed text, or `null` when unused.
 * @returns The validated seed text, or `null`.
 * @throws {RangeError} If the seed is not canonical unsigned-64 decimal.
 */
export function encodeSeed(seed: string | null): string | null {
  if (seed === null) {
    return null;
  }
  if (!U64_DECIMAL.test(seed) || BigInt(seed) > MAX_U64_SEED) {
    throw new RangeError(
      `seed must be canonical decimal in 0..${MAX_U64_SEED}, got ${JSON.stringify(seed)}`,
    );
  }
  return seed;
}

/**
 * Decode a seed column back to canonical decimal text, validating the range.
 *
 * @param seed - The stored seed text, or `null`.
 * @returns The validated seed text, or `null`.
 * @throws {RangeError} If a stored seed is not canonical unsigned-64 decimal.
 */
export function decodeSeed(seed: string | null): string | null {
  return encodeSeed(seed);
}

// --- limits serialization -------------------------------------------------

/**
 * Serialize {@link ResourceLimits} to the canonical `limits_json` text.
 *
 * @param limits - The resource limits to serialize.
 * @returns A JSON string with keys in a stable order.
 */
export function serializeLimits(limits: ResourceLimits): string {
  return JSON.stringify(limits);
}

/**
 * Parse a `limits_json` value back into a validated {@link ResourceLimits}.
 *
 * @param json - The stored JSON text.
 * @returns The reconstructed, frozen resource limits.
 * @throws {RangeError} If the JSON does not describe well-formed limits.
 */
export function deserializeLimits(json: string): ResourceLimits {
  const parsed = JSON.parse(json) as Record<string, number>;
  return createResourceLimits({
    wallTimeMs: parsed["wallTimeMs"]!,
    cpuTimeMs: parsed["cpuTimeMs"]!,
    memoryBytes: parsed["memoryBytes"]!,
    stdoutBytes: parsed["stdoutBytes"]!,
    stderrBytes: parsed["stderrBytes"]!,
    combinedOutputBytes: parsed["combinedOutputBytes"]!,
    inputBytes: parsed["inputBytes"]!,
    fileSizeBytes: parsed["fileSizeBytes"]!,
    processCount: parsed["processCount"]!,
    openDescriptors: parsed["openDescriptors"]!,
    tempStorageBytes: parsed["tempStorageBytes"]!,
    concurrencyPerCase: parsed["concurrencyPerCase"]!,
  });
}

// --- run Memento mapping --------------------------------------------------

/**
 * Project a {@link PersistableRun} Memento onto its storage row.
 *
 * The orchestration-only columns the Memento does not carry (`command`,
 * `problem_id`, `environment_id`, `finished_at`, `methodology_version`, and the
 * benchmark plan) are left `null`; a command producer fills them when it has
 * them. `wallTimeUtc` maps to `started_at`, and `durationMs` to `duration_ms`.
 *
 * @param run - The immutable run snapshot.
 * @returns The fully-populated {@link RunRow}.
 */
export function runToRow(run: PersistableRun): RunRow {
  return {
    run_id: run.runId,
    problem_id: null,
    slug: run.slug,
    command: null,
    seed: encodeSeed(run.seed),
    state: run.state,
    status: run.status,
    problem_fingerprint: run.problemFingerprint,
    input_codec_version: run.inputCodecVersion,
    output_codec_version: run.outputCodecVersion,
    comparator_version: run.comparisonPolicyVersion,
    methodology_version: run.benchmark?.methodologyVersion ?? null,
    input_hash: run.inputHash,
    output_hash: run.outputHash,
    generation: run.generation,
    started_at: run.wallTimeUtc,
    finished_at: null,
    duration_ms: run.durationMs,
    limits_json: serializeLimits(run.limits),
    environment_id: run.benchmark?.environmentId ?? null,
    benchmark_warmups: run.benchmark?.warmups ?? null,
    benchmark_sample_count: run.benchmark?.sampleCount ?? null,
    benchmark_order_seed: run.benchmark?.orderSeed ?? null,
    benchmark_plan_sha256: run.benchmark?.planSha256 ?? null,
    benchmark_comparability:
      run.benchmark === undefined ? null : run.benchmark.comparable ? 1 : 0,
    benchmark_comparability_reason: run.benchmark?.comparabilityReason ?? null,
  };
}

/**
 * Read a raw run result set row into a typed {@link RunRow}, coercing 64-bit
 * integer columns down to `number` for the small count/duration fields.
 *
 * @param raw - The raw column map from a `SELECT * FROM run` query.
 * @returns The typed row.
 */
export function readRunRow(raw: SqliteRow): RunRow {
  return {
    run_id: textCol(raw, "run_id"),
    problem_id: nullableTextCol(raw, "problem_id"),
    slug: textCol(raw, "slug"),
    command: nullableTextCol(raw, "command"),
    seed: nullableTextCol(raw, "seed"),
    state: textCol(raw, "state"),
    status: textCol(raw, "status"),
    problem_fingerprint: textCol(raw, "problem_fingerprint"),
    input_codec_version: textCol(raw, "input_codec_version"),
    output_codec_version: textCol(raw, "output_codec_version"),
    comparator_version: textCol(raw, "comparator_version"),
    methodology_version: nullableTextCol(raw, "methodology_version"),
    input_hash: textCol(raw, "input_hash"),
    output_hash: nullableTextCol(raw, "output_hash"),
    generation: intCol(raw, "generation"),
    started_at: textCol(raw, "started_at"),
    finished_at: nullableTextCol(raw, "finished_at"),
    duration_ms: intCol(raw, "duration_ms"),
    limits_json: textCol(raw, "limits_json"),
    environment_id: nullableTextCol(raw, "environment_id"),
    benchmark_warmups: nullableIntCol(raw, "benchmark_warmups"),
    benchmark_sample_count: nullableIntCol(raw, "benchmark_sample_count"),
    benchmark_order_seed: nullableTextCol(raw, "benchmark_order_seed"),
    benchmark_plan_sha256: nullableTextCol(raw, "benchmark_plan_sha256"),
    benchmark_comparability: boolCol(raw, "benchmark_comparability"),
    benchmark_comparability_reason: nullableTextCol(
      raw,
      "benchmark_comparability_reason",
    ),
  };
}

/**
 * Reconstruct a {@link PersistableRun} Memento from its storage row.
 *
 * @param row - The typed run row.
 * @returns The immutable run snapshot.
 */
export function rowToRun(row: RunRow): PersistableRun {
  return {
    runId: toRunId(row.run_id),
    slug: row.slug,
    state: row.state as TerminalRunState,
    status: row.status as ExecutionStatus,
    problemFingerprint: row.problem_fingerprint,
    seed: decodeSeed(row.seed),
    limits: deserializeLimits(row.limits_json),
    inputCodecVersion: row.input_codec_version,
    outputCodecVersion: row.output_codec_version,
    comparisonPolicyVersion: row.comparator_version,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    generation: row.generation as Generation,
    wallTimeUtc: row.started_at,
    durationMs: row.duration_ms,
    ...(row.methodology_version === null
      ? {}
      : {
          benchmark: {
            methodologyVersion: row.methodology_version,
            warmups: row.benchmark_warmups ?? 0,
            sampleCount: row.benchmark_sample_count ?? 0,
            orderSeed: row.benchmark_order_seed ?? "0",
            planSha256: row.benchmark_plan_sha256 ?? "",
            comparable: row.benchmark_comparability === 1,
            comparabilityReason: row.benchmark_comparability_reason,
            environmentId: row.environment_id ?? "",
          },
        }),
  };
}

/** The column list bound when inserting a run row, in a stable order. */
const RUN_COLUMNS: readonly (keyof RunRow)[] = [
  "run_id",
  "problem_id",
  "slug",
  "command",
  "seed",
  "state",
  "status",
  "problem_fingerprint",
  "input_codec_version",
  "output_codec_version",
  "comparator_version",
  "methodology_version",
  "input_hash",
  "output_hash",
  "generation",
  "started_at",
  "finished_at",
  "duration_ms",
  "limits_json",
  "environment_id",
  "benchmark_warmups",
  "benchmark_sample_count",
  "benchmark_order_seed",
  "benchmark_plan_sha256",
  "benchmark_comparability",
  "benchmark_comparability_reason",
];

/**
 * Build the parameterized `INSERT` statement text and bound parameters for a
 * run row. The column and placeholder lists are derived from a fixed constant,
 * never from row data, so no value can influence the statement shape.
 *
 * @param row - The run row to insert.
 * @returns The SQL text and its bound named parameters.
 */
export function runInsert(row: RunRow): { sql: string; params: SqlParams } {
  const columns = RUN_COLUMNS.join(", ");
  const placeholders = RUN_COLUMNS.map((c) => `:${c}`).join(", ");
  const params: SqlParams = {};
  for (const column of RUN_COLUMNS) {
    params[column] = row[column];
  }
  return {
    sql: `INSERT INTO run (${columns}) VALUES (${placeholders})`,
    params,
  };
}

// --- run query ------------------------------------------------------------

/**
 * Translate a {@link RunQuery} into a parameterized `WHERE`/`ORDER`/`LIMIT`
 * suffix. Absent fields impose no filter. Every value is bound, so a malicious
 * slug or status can never alter the statement.
 *
 * @param query - The query filters.
 * @returns The SQL suffix and its bound parameters.
 */
export function buildRunWhere(query: RunQuery): {
  sql: string;
  params: SqlParams;
} {
  const conditions: string[] = [];
  const params: SqlParams = {};

  if (query.slug !== undefined) {
    conditions.push("slug = :slug");
    params["slug"] = query.slug;
  }
  if (query.since !== undefined) {
    conditions.push("started_at >= :since");
    params["since"] = query.since;
  }
  if (query.status !== undefined) {
    conditions.push("status = :status");
    params["status"] = query.status;
  }

  const where =
    conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  let sql = `${where} ORDER BY started_at DESC, run_id DESC`;

  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 0) {
      throw new RangeError(
        `run query limit must be a non-negative safe integer, got ${String(query.limit)}`,
      );
    }
    sql += " LIMIT :limit";
    params["limit"] = query.limit;
  }

  return { sql, params };
}
