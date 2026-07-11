/**
 * Row input/output helpers shared by the repositories, exporter, and recovery.
 *
 * `insertObject` builds a fully parameterized `INSERT` from a typed row: the
 * column names come from the row's own keys (which the adapter controls), and
 * every value is bound, so untrusted content can never alter the statement. The
 * per-table readers coerce a raw column map into the typed row interface,
 * applying the shared conventions (bigint nanoseconds/bytes, nullable columns,
 * stored booleans) from {@link module:./mappers.js}.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { SqlParams, SqlValue, SqliteConnection, SqliteRow } from "./connection.js";
import {
  bigIntCol,
  boolCol,
  intCol,
  nullableBigIntCol,
  nullableIntCol,
  nullableTextCol,
  textCol,
} from "./mappers.js";
import type {
  ArtifactRow,
  BenchmarkAggregateRow,
  BenchmarkSampleRow,
  CaseRow,
  DailyMetricRow,
  EnvironmentRow,
  ExecutionRow,
  ImplementationRow,
  ProblemRow,
} from "./rows.js";

/** Quote a table name, guarding the SQLite `case` keyword. */
export function quoteTable(table: string): string {
  return table === "case" ? '"case"' : table;
}

/**
 * Insert a typed row into a table using bound parameters.
 *
 * The column list is derived from the row's own keys — never from any value —
 * so this is injection-safe for arbitrary column contents.
 *
 * @param db - The connection (a writer, inside a transaction, for durability).
 * @param table - The destination table name.
 * @param row - The typed row; its keys are the column names.
 */
export function insertObject(
  db: SqliteConnection,
  table: string,
  row: object,
): void {
  const entries = Object.entries(row as Record<string, SqlValue>);
  const columns = entries.map(([key]) => key);
  const placeholders = columns.map((c) => `:${c}`).join(", ");
  const sql = `INSERT INTO ${quoteTable(table)} (${columns.join(", ")}) VALUES (${placeholders})`;
  const params: SqlParams = {};
  for (const [key, value] of entries) {
    params[key] = value;
  }
  db.prepare(sql).run(params);
}

/** Read a raw row into a {@link ProblemRow}. */
export function readProblemRow(raw: SqliteRow): ProblemRow {
  return {
    problem_id: textCol(raw, "problem_id"),
    slug: textCol(raw, "slug"),
    schema_version: intCol(raw, "schema_version"),
    title: textCol(raw, "title"),
    created_at: textCol(raw, "created_at"),
    updated_at: textCol(raw, "updated_at"),
  };
}

/** Read a raw row into an {@link ImplementationRow}. */
export function readImplementationRow(raw: SqliteRow): ImplementationRow {
  return {
    implementation_id: textCol(raw, "implementation_id"),
    problem_id: textCol(raw, "problem_id"),
    path: textCol(raw, "path"),
    role: textCol(raw, "role"),
    content_sha256: textCol(raw, "content_sha256"),
    runtime: textCol(raw, "runtime"),
    created_at: textCol(raw, "created_at"),
  };
}

/** Read a raw row into a {@link CaseRow}. */
export function readCaseRow(raw: SqliteRow): CaseRow {
  return {
    case_id: textCol(raw, "case_id"),
    run_id: textCol(raw, "run_id"),
    ordinal: intCol(raw, "ordinal"),
    input_sha256: textCol(raw, "input_sha256"),
    input_bytes: bigIntCol(raw, "input_bytes"),
    status: textCol(raw, "status"),
  };
}

/** Read a raw row into an {@link ExecutionRow}. */
export function readExecutionRow(raw: SqliteRow): ExecutionRow {
  return {
    execution_id: textCol(raw, "execution_id"),
    case_id: textCol(raw, "case_id"),
    implementation_id: textCol(raw, "implementation_id"),
    status: textCol(raw, "status"),
    exit_code: nullableIntCol(raw, "exit_code"),
    signal: nullableTextCol(raw, "signal"),
    wall_ns: nullableBigIntCol(raw, "wall_ns"),
    cpu_ns: nullableBigIntCol(raw, "cpu_ns"),
    peak_memory_bytes: nullableBigIntCol(raw, "peak_memory_bytes"),
    stdout_bytes: nullableBigIntCol(raw, "stdout_bytes"),
    stderr_bytes: nullableBigIntCol(raw, "stderr_bytes"),
    stdout_truncated: boolCol(raw, "stdout_truncated"),
    stderr_truncated: boolCol(raw, "stderr_truncated"),
    limit_cause: nullableTextCol(raw, "limit_cause"),
    raw_json: nullableTextCol(raw, "raw_json"),
  };
}

/** Read a raw row into a {@link BenchmarkSampleRow}. */
export function readSampleRow(raw: SqliteRow): BenchmarkSampleRow {
  return {
    sample_id: textCol(raw, "sample_id"),
    run_id: textCol(raw, "run_id"),
    case_id: textCol(raw, "case_id"),
    implementation_id: textCol(raw, "implementation_id"),
    ordinal: intCol(raw, "ordinal"),
    warmup: boolCol(raw, "warmup"),
    status: textCol(raw, "status"),
    setup_ns: nullableBigIntCol(raw, "setup_ns"),
    target_ns: nullableBigIntCol(raw, "target_ns"),
    total_ns: nullableBigIntCol(raw, "total_ns"),
    peak_memory_bytes: nullableBigIntCol(raw, "peak_memory_bytes"),
    raw_json: nullableTextCol(raw, "raw_json"),
  };
}

/** Read a raw row into a {@link BenchmarkAggregateRow}. */
export function readAggregateRow(raw: SqliteRow): BenchmarkAggregateRow {
  return {
    aggregate_id: textCol(raw, "aggregate_id"),
    run_id: textCol(raw, "run_id"),
    implementation_id: textCol(raw, "implementation_id"),
    case_id: textCol(raw, "case_id"),
    valid_count: intCol(raw, "valid_count"),
    failed_count: intCol(raw, "failed_count"),
    min_ns: nullableBigIntCol(raw, "min_ns"),
    median_ns: nullableBigIntCol(raw, "median_ns"),
    p90_ns: nullableBigIntCol(raw, "p90_ns"),
    p95_ns: nullableBigIntCol(raw, "p95_ns"),
    p99_ns: nullableBigIntCol(raw, "p99_ns"),
    max_ns: nullableBigIntCol(raw, "max_ns"),
    mean_ns: nullableBigIntCol(raw, "mean_ns"),
    stddev_ns: nullableBigIntCol(raw, "stddev_ns"),
    memory_median_bytes: nullableBigIntCol(raw, "memory_median_bytes"),
    memory_p95_bytes: nullableBigIntCol(raw, "memory_p95_bytes"),
    memory_max_bytes: nullableBigIntCol(raw, "memory_max_bytes"),
  };
}

/** Read a raw row into an {@link ArtifactRow}. */
export function readArtifactRow(raw: SqliteRow): ArtifactRow {
  return {
    artifact_id: textCol(raw, "artifact_id"),
    run_id: textCol(raw, "run_id"),
    kind: textCol(raw, "kind"),
    path: textCol(raw, "path"),
    sha256: textCol(raw, "sha256"),
    size_bytes: bigIntCol(raw, "size_bytes"),
    created_at: textCol(raw, "created_at"),
  };
}

/** Read a raw row into an {@link EnvironmentRow}. */
export function readEnvironmentRow(raw: SqliteRow): EnvironmentRow {
  return {
    environment_id: textCol(raw, "environment_id"),
    host_fingerprint: textCol(raw, "host_fingerprint"),
    kernel: textCol(raw, "kernel"),
    cpu_model: textCol(raw, "cpu_model"),
    python_version: textCol(raw, "python_version"),
    uv_version: textCol(raw, "uv_version"),
    node_version: textCol(raw, "node_version"),
    sandbox_mode: textCol(raw, "sandbox_mode"),
    database_mode: textCol(raw, "database_mode"),
    cpu_governor: nullableTextCol(raw, "cpu_governor"),
    cpu_frequency: nullableTextCol(raw, "cpu_frequency"),
    limits_json: textCol(raw, "limits_json"),
  };
}

/** Read a raw row into a {@link DailyMetricRow}. */
export function readMetricRow(raw: SqliteRow): DailyMetricRow {
  return {
    metric_date: textCol(raw, "metric_date"),
    problem_id: textCol(raw, "problem_id"),
    attempts: intCol(raw, "attempts"),
    passes: intCol(raw, "passes"),
    failures: intCol(raw, "failures"),
    wall_ns: bigIntCol(raw, "wall_ns"),
    solved_at: nullableTextCol(raw, "solved_at"),
  };
}
