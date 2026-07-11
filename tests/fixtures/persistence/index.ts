/**
 * Persistence fixtures for the contract and unit suites.
 *
 * Provides a temp-directory–backed {@link SqliteStore} factory (so every test
 * gets an isolated real database that WAL can open on a local filesystem) plus
 * small builders for a {@link PersistableRun} and the child rows a run commits
 * with. These are scaffolding shared across suites; task 17 extends them for the
 * black-box harness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResourceLimits,
  initialGeneration,
  toRunId,
} from "../../../src/domain/index.js";
import type { PersistableRun, ResourceLimits } from "../../../src/domain/index.js";
import type { SqliteConnection } from "../../../src/persistence/sqlite/connection.js";
import { openWriter } from "../../../src/persistence/sqlite/connection.js";
import { configureConnection } from "../../../src/persistence/sqlite/durability.js";
import { runInsert, runToRow } from "../../../src/persistence/sqlite/mappers.js";
import { insertObject } from "../../../src/persistence/sqlite/row-io.js";
import { migrate } from "../../../src/persistence/sqlite/schema.js";
import { openSqliteStore } from "../../../src/persistence/sqlite/index.js";
import type {
  SqliteStore,
  SqliteStoreConfig,
} from "../../../src/persistence/sqlite/index.js";
import type {
  BenchmarkAggregateRow,
  BenchmarkSampleRow,
  DailyMetricRow,
  ProblemRow,
} from "../../../src/persistence/sqlite/index.js";
import type {
  CaseRow,
  ExecutionRow,
  ImplementationRow,
} from "../../../src/persistence/sqlite/rows.js";

/** A representative, well-formed set of resource limits. */
export function sampleLimits(): ResourceLimits {
  return createResourceLimits({
    wallTimeMs: 2000,
    cpuTimeMs: 1000,
    memoryBytes: 268_435_456,
    stdoutBytes: 1_048_576,
    stderrBytes: 1_048_576,
    combinedOutputBytes: 2_097_152,
    inputBytes: 1_048_576,
    fileSizeBytes: 10_485_760,
    processCount: 64,
    openDescriptors: 256,
    tempStorageBytes: 33_554_432,
    concurrencyPerCase: 1,
  });
}

/** Build a {@link PersistableRun}, overriding any fields for the scenario. */
export function makeRun(overrides: Partial<PersistableRun> = {}): PersistableRun {
  return {
    runId: toRunId("run-0001"),
    slug: "two-sum",
    state: "completed",
    status: "passed",
    problemFingerprint: "fingerprint-0001",
    seed: null,
    limits: sampleLimits(),
    inputCodecVersion: "tagged-jsonl-v1",
    outputCodecVersion: "tagged-jsonl-v1",
    comparisonPolicyVersion: "exact-v1",
    inputHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    generation: initialGeneration(),
    wallTimeUtc: "2026-07-20T00:00:00.000Z",
    durationMs: 42,
    ...overrides,
  };
}

/** Build a {@link ProblemRow}, overriding any fields for the scenario. */
export function makeProblem(overrides: Partial<ProblemRow> = {}): ProblemRow {
  return {
    problem_id: "prob-0001",
    slug: "two-sum",
    schema_version: 1,
    title: "Two Sum",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a {@link BenchmarkSampleRow} for a given run/case/impl. */
export function makeSample(
  overrides: Partial<BenchmarkSampleRow> = {},
): BenchmarkSampleRow {
  return {
    sample_id: "sample-0001",
    run_id: "run-0001",
    case_id: "case-0001",
    implementation_id: "impl-0001",
    ordinal: 0,
    warmup: 0,
    status: "passed",
    setup_ns: 1_000n,
    target_ns: 5_000n,
    total_ns: 6_000n,
    peak_memory_bytes: 1_000_000n,
    raw_json: null,
    ...overrides,
  };
}

/** Build a {@link BenchmarkAggregateRow} for a given run/case/impl. */
export function makeAggregate(
  overrides: Partial<BenchmarkAggregateRow> = {},
): BenchmarkAggregateRow {
  return {
    aggregate_id: "agg-0001",
    run_id: "run-0001",
    implementation_id: "impl-0001",
    case_id: "case-0001",
    valid_count: 10,
    failed_count: 0,
    min_ns: 4_000n,
    median_ns: 5_000n,
    p90_ns: 6_000n,
    p95_ns: 6_500n,
    p99_ns: 7_000n,
    max_ns: 8_000n,
    mean_ns: 5_200n,
    stddev_ns: 900n,
    memory_median_bytes: 1_000_000n,
    memory_p95_bytes: 1_200_000n,
    memory_max_bytes: 1_500_000n,
    ...overrides,
  };
}

/** Build a {@link DailyMetricRow} for a given date/problem. */
export function makeMetric(
  overrides: Partial<DailyMetricRow> = {},
): DailyMetricRow {
  return {
    metric_date: "2026-07-20",
    problem_id: "prob-0001",
    attempts: 1,
    passes: 1,
    failures: 0,
    wall_ns: 42_000_000n,
    solved_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

/** Build an {@link ImplementationRow} for a given problem. */
export function makeImplementation(
  overrides: Partial<ImplementationRow> = {},
): ImplementationRow {
  return {
    implementation_id: "impl-0001",
    problem_id: "prob-0001",
    path: "solution.py",
    role: "solution",
    content_sha256: "c".repeat(64),
    runtime: "python-uv",
    created_at: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a {@link CaseRow} for a given run. */
export function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    case_id: "case-0001",
    run_id: "run-0001",
    ordinal: 0,
    input_sha256: "d".repeat(64),
    input_bytes: 128n,
    status: "passed",
    ...overrides,
  };
}

/** Build an {@link ExecutionRow} for a given case/implementation. */
export function makeExecution(
  overrides: Partial<ExecutionRow> = {},
): ExecutionRow {
  return {
    execution_id: "exec-0001",
    case_id: "case-0001",
    implementation_id: "impl-0001",
    status: "passed",
    exit_code: 0,
    signal: null,
    wall_ns: 5_000_000n,
    cpu_ns: 4_000_000n,
    peak_memory_bytes: 1_000_000n,
    stdout_bytes: 16n,
    stderr_bytes: 0n,
    stdout_truncated: 0,
    stderr_truncated: 0,
    limit_cause: null,
    raw_json: '{"v":1}',
    ...overrides,
  };
}

/**
 * Seed a parent graph (problem → implementation → run → case) on an existing
 * connection, without opening a transaction of its own.
 *
 * @param db - The writer connection to insert into.
 */
export function seedGraphOn(db: SqliteConnection): void {
  insertObject(db, "problem", makeProblem());
  insertObject(db, "implementation", makeImplementation());
  const { sql, params } = runInsert(runToRow(makeRun()));
  db.prepare(sql).run(params);
  insertObject(db, "case", makeCase());
}

/**
 * Seed a full parent graph (problem → implementation → run → case) on the
 * database at `path`, so benchmark samples/aggregates can satisfy their foreign
 * keys. Opens a short-lived raw writer and commits the inserts atomically.
 *
 * @param path - The database file path (an already-migrated store DB).
 */
export function seedRunGraph(path: string): void {
  const db = openWriter(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec("BEGIN IMMEDIATE");
  try {
    seedGraphOn(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

/** A temp store bundled with its on-disk path and a cleanup callback. */
export interface TempStore {
  /** The opened store. */
  readonly store: SqliteStore;
  /** The database file path. */
  readonly path: string;
  /** Close the store and remove its temp directory. */
  cleanup(): void;
}

/**
 * Open a {@link SqliteStore} in a fresh temp directory.
 *
 * @param config - Optional extra store config merged over the temp path.
 * @returns The store, its path, and a `cleanup()` that closes and deletes it.
 */
export function createTempStore(
  config: Omit<SqliteStoreConfig, "path"> = {},
): TempStore {
  const dir = mkdtempSync(join(tmpdir(), "palestra-sqlite-"));
  const path = join(dir, "store.db");
  const store = openSqliteStore({ path, ...config });
  return {
    store,
    path,
    cleanup(): void {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A raw, migrated writer connection bundled with its path and cleanup. */
export interface RawDb {
  /** The configured read-write connection (WAL, FKs, schema applied). */
  readonly db: SqliteConnection;
  /** The database file path. */
  readonly path: string;
  /** Close the connection and remove its temp directory. */
  cleanup(): void;
}

/**
 * Open a raw writer connection to a fresh temp database, configured for
 * durability and migrated to the current schema. Gives unit tests direct SQL
 * access (PRAGMAs, arbitrary statements) that the store facade hides.
 *
 * @returns The connection, its path, and a `cleanup()`.
 */
export function createRawDb(): RawDb {
  const dir = mkdtempSync(join(tmpdir(), "palestra-sqlite-raw-"));
  const path = join(dir, "store.db");
  const db = openWriter(path);
  configureConnection(db, "read-write");
  migrate(db);
  return {
    db,
    path,
    cleanup(): void {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
