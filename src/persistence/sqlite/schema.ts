/**
 * Schema v1 DDL, application, and migration for the SQLite store.
 *
 * The schema is the machine-checked encoding of `docs/storage/sqlite-metrics.md`:
 * ten tables with exact primary keys, foreign-key delete behavior
 * (`CASCADE` for run/case children, `RESTRICT` for `implementation`,
 * `environment`, and referenced `problem`s), the `execution` and
 * `benchmark_sample` uniqueness rules, the `benchmark_comparability` ↔ reason
 * CHECK, and the lookup indexes. `PRAGMA user_version` records the schema
 * version so an unknown or newer database is refused rather than migrated
 * blindly.
 *
 * This is an adapter module; it manipulates a {@link SqliteConnection} but
 * imports the driver only as a type.
 */

import type { SqliteConnection } from "./connection.js";
import { SchemaVersionError } from "./errors.js";

/** The schema version this build creates and understands. */
export const SCHEMA_VERSION = 1;

/**
 * The persisted table names, in dependency order (parents before children).
 *
 * Used by the exporter to stream every table and by tests to assert the schema
 * surface. `"case"` is a SQLite keyword and is always quoted in SQL.
 */
export const TABLE_NAMES = [
  "problem",
  "environment",
  "implementation",
  "run",
  "case",
  "execution",
  "benchmark_sample",
  "benchmark_aggregate",
  "artifact",
  "daily_metric",
] as const;

/** One of the persisted table names. */
export type TableName = (typeof TABLE_NAMES)[number];

/**
 * The complete schema v1 DDL.
 *
 * Foreign keys are declared inline; delete behavior follows the spec. The
 * `benchmark_comparability` CHECK ties the nullable boolean to its reason:
 * `NULL`/`NULL` for non-benchmark runs, `1`/`NULL` when comparable, and
 * `0`/non-null when non-comparable.
 */
const SCHEMA_DDL = `
CREATE TABLE problem (
  problem_id     TEXT    PRIMARY KEY,
  slug           TEXT    NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  title          TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE environment (
  environment_id   TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  kernel           TEXT NOT NULL,
  cpu_model        TEXT NOT NULL,
  python_version   TEXT NOT NULL,
  uv_version       TEXT NOT NULL,
  node_version     TEXT NOT NULL,
  sandbox_mode     TEXT NOT NULL,
  database_mode    TEXT NOT NULL,
  cpu_governor     TEXT,
  cpu_frequency    TEXT,
  limits_json      TEXT NOT NULL
);

CREATE TABLE implementation (
  implementation_id TEXT PRIMARY KEY,
  problem_id        TEXT NOT NULL REFERENCES problem(problem_id) ON DELETE RESTRICT,
  path              TEXT NOT NULL,
  role              TEXT NOT NULL,
  content_sha256    TEXT NOT NULL,
  runtime           TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE run (
  run_id                         TEXT    PRIMARY KEY,
  problem_id                     TEXT    REFERENCES problem(problem_id) ON DELETE RESTRICT,
  slug                           TEXT    NOT NULL,
  command                        TEXT,
  seed                           TEXT,
  state                          TEXT    NOT NULL,
  status                         TEXT    NOT NULL,
  problem_fingerprint            TEXT    NOT NULL,
  input_codec_version            TEXT    NOT NULL,
  output_codec_version           TEXT    NOT NULL,
  comparator_version             TEXT    NOT NULL,
  methodology_version            TEXT,
  input_hash                     TEXT    NOT NULL,
  output_hash                    TEXT,
  generation                     INTEGER NOT NULL,
  started_at                     TEXT    NOT NULL,
  finished_at                    TEXT,
  duration_ms                    INTEGER NOT NULL,
  limits_json                    TEXT    NOT NULL,
  environment_id                 TEXT    REFERENCES environment(environment_id) ON DELETE RESTRICT,
  benchmark_warmups              INTEGER,
  benchmark_sample_count         INTEGER,
  benchmark_order_seed           TEXT,
  benchmark_comparability        INTEGER,
  benchmark_comparability_reason TEXT,
  CHECK (
    (benchmark_comparability IS NULL AND benchmark_comparability_reason IS NULL)
    OR (benchmark_comparability = 1 AND benchmark_comparability_reason IS NULL)
    OR (benchmark_comparability = 0 AND benchmark_comparability_reason IS NOT NULL)
  )
);

CREATE TABLE "case" (
  case_id      TEXT    PRIMARY KEY,
  run_id       TEXT    NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  input_sha256 TEXT    NOT NULL,
  input_bytes  INTEGER NOT NULL,
  status       TEXT    NOT NULL
);

CREATE TABLE execution (
  execution_id      TEXT    PRIMARY KEY,
  case_id           TEXT    NOT NULL REFERENCES "case"(case_id) ON DELETE CASCADE,
  implementation_id TEXT    NOT NULL REFERENCES implementation(implementation_id) ON DELETE RESTRICT,
  status            TEXT    NOT NULL,
  exit_code         INTEGER,
  signal            TEXT,
  wall_ns           INTEGER,
  cpu_ns            INTEGER,
  peak_memory_bytes INTEGER,
  stdout_bytes      INTEGER,
  stderr_bytes      INTEGER,
  stdout_truncated  INTEGER,
  stderr_truncated  INTEGER,
  limit_cause       TEXT,
  raw_json          TEXT,
  UNIQUE (case_id, implementation_id)
);

CREATE TABLE benchmark_sample (
  sample_id         TEXT    PRIMARY KEY,
  run_id            TEXT    NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  case_id           TEXT    NOT NULL REFERENCES "case"(case_id) ON DELETE CASCADE,
  implementation_id TEXT    NOT NULL REFERENCES implementation(implementation_id) ON DELETE RESTRICT,
  ordinal           INTEGER NOT NULL,
  warmup            INTEGER,
  status            TEXT    NOT NULL,
  setup_ns          INTEGER,
  target_ns         INTEGER,
  total_ns          INTEGER,
  peak_memory_bytes INTEGER,
  raw_json          TEXT,
  UNIQUE (run_id, case_id, implementation_id, ordinal)
);

CREATE TABLE benchmark_aggregate (
  aggregate_id        TEXT    PRIMARY KEY,
  run_id              TEXT    NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  implementation_id   TEXT    NOT NULL REFERENCES implementation(implementation_id) ON DELETE RESTRICT,
  case_id             TEXT    NOT NULL REFERENCES "case"(case_id) ON DELETE CASCADE,
  valid_count         INTEGER NOT NULL,
  failed_count        INTEGER NOT NULL,
  min_ns              INTEGER,
  median_ns           INTEGER,
  p90_ns              INTEGER,
  p95_ns              INTEGER,
  p99_ns              INTEGER,
  max_ns              INTEGER,
  mean_ns             INTEGER,
  stddev_ns           INTEGER,
  memory_median_bytes INTEGER,
  memory_p95_bytes    INTEGER,
  memory_max_bytes    INTEGER
);

CREATE TABLE artifact (
  artifact_id TEXT    PRIMARY KEY,
  run_id      TEXT    NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL
);

CREATE TABLE daily_metric (
  metric_date TEXT    NOT NULL,
  problem_id  TEXT    NOT NULL REFERENCES problem(problem_id) ON DELETE RESTRICT,
  attempts    INTEGER NOT NULL,
  passes      INTEGER NOT NULL,
  failures    INTEGER NOT NULL,
  wall_ns     INTEGER NOT NULL,
  solved_at   TEXT,
  PRIMARY KEY (metric_date, problem_id)
);

CREATE INDEX idx_daily_problem_date ON daily_metric (problem_id, metric_date);
CREATE INDEX idx_run_slug_started   ON run (slug, started_at);
CREATE INDEX idx_run_status_started ON run (status, started_at);
CREATE INDEX idx_execution_status   ON execution (status);
CREATE INDEX idx_impl_content       ON implementation (content_sha256);
CREATE INDEX idx_bench_sample_lookup
  ON benchmark_sample (run_id, case_id, implementation_id);
CREATE INDEX idx_bench_agg_run      ON benchmark_aggregate (run_id);
`;

/** Read the on-disk `user_version` from the connection. */
function readUserVersion(db: SqliteConnection): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/** Whether the database has no user-defined tables (a fresh file). */
function isEmptyDatabase(db: SqliteConnection): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get();
  const count = row?.["n"];
  return (typeof count === "bigint" ? Number(count) : Number(count ?? 0)) === 0;
}

/**
 * Create the schema v1 tables and indexes and stamp `user_version`.
 *
 * The whole operation runs inside a single transaction so a half-created schema
 * can never be observed: either every object exists and the version is set, or
 * nothing is committed.
 *
 * @param db - The writable connection to apply the schema to.
 */
export function applySchema(db: SqliteConnection): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_DDL);
    // SCHEMA_VERSION is a build-time integer constant, never user input.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Bring the database to schema v1, creating it when the file is fresh.
 *
 * - A brand-new (empty) database is initialized with {@link applySchema}.
 * - A database already at {@link SCHEMA_VERSION} is accepted unchanged.
 * - Any other version (an older populated database with `user_version = 0`, or
 *   a newer version this build does not understand) is refused.
 *
 * @param db - The writable connection to migrate.
 * @throws {SchemaVersionError} If the on-disk version is unknown or newer.
 */
export function migrate(db: SqliteConnection): void {
  const version = readUserVersion(db);
  if (version === SCHEMA_VERSION) {
    return;
  }
  if (version === 0 && isEmptyDatabase(db)) {
    applySchema(db);
    return;
  }
  throw new SchemaVersionError(version, SCHEMA_VERSION);
}
