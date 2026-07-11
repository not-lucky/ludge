/**
 * The SQLite store facade and its open-time factory.
 *
 * {@link SqliteStore} is the single object the composition root wires: it owns
 * one serialized writer connection (behind the {@link TransactionScope} write
 * seam) and a separate read-only connection for queries, so reads never contend
 * with the writer and a stray read-path write is rejected by the engine.
 * {@link openSqliteStore} performs the whole safe-open sequence in order — prove
 * the path is local, open and configure the writer for durability, migrate to the
 * current schema, verify integrity and recover interrupted runs, and optionally
 * prune stale raw payloads — before any caller can touch the store. Any durability
 * problem surfaces as a {@link DurabilityConfigError} the caller maps to its
 * configuration exit path.
 *
 * This is an adapter module and uses Node builtins (via the connection seam).
 */

import type {
  BenchmarkRepository,
  MetricsRepository,
  ProblemRepository,
  RunRepository,
  TransactionScope,
} from "../ports/index.js";
import type { SqliteConnection } from "./connection.js";
import { openReader, openWriter } from "./connection.js";
import { configureConnection } from "./durability.js";
import { exportJsonl } from "./export.js";
import type { JsonlSink } from "./export.js";
import type { FilesystemProbe } from "./filesystem-probe.js";
import { assertLocalFilesystem } from "./filesystem-probe.js";
import { runStartupRecovery } from "./recovery.js";
import { applyRetention } from "./retention.js";
import { SqliteBenchmarkRepository } from "./repositories/benchmark-repository.js";
import { SqliteMetricsRepository } from "./repositories/metrics-repository.js";
import { SqliteProblemRepository } from "./repositories/problem-repository.js";
import { SqliteRunRepository } from "./repositories/run-repository.js";
import type { SqlitePersistenceRecords } from "./rows.js";
import { migrate } from "./schema.js";
import { SqliteTransactionScope } from "./transaction-scope.js";
import type { BusyRetryOptions, Sleeper } from "./writer-queue.js";
import { WriterQueue } from "./writer-queue.js";

/** Configuration for {@link openSqliteStore}. */
export interface SqliteStoreConfig {
  /** Absolute path to the database file (or `":memory:"`). */
  readonly path: string;
  /** Filesystem probe; defaults to a real `statfs` probe. */
  readonly filesystemProbe?: FilesystemProbe;
  /** Busy-retry bounds for the writer; defaults to the module default. */
  readonly busyRetry?: BusyRetryOptions;
  /** Injectable sleeper for busy-retry backoff (tests pass a fake). */
  readonly sleep?: Sleeper;
  /**
   * When set, {@link applyRetention} runs at open with this instant as `now`.
   * Omit to skip retention on open (the caller can run it later).
   */
  readonly retentionNow?: Date;
}

/**
 * A durable SQLite store: one writer behind the transaction seam plus a
 * read-only query connection.
 */
export class SqliteStore {
  /** The atomic write seam; every durable mutation flows through it. */
  public readonly transaction: TransactionScope<SqlitePersistenceRecords>;

  /** Read-only runs accessor (backed by the reader connection). */
  public readonly runs: RunRepository;
  /** Read-only problems accessor. */
  public readonly problems: ProblemRepository<SqlitePersistenceRecords>;
  /** Read-only benchmarks accessor. */
  public readonly benchmarks: BenchmarkRepository<SqlitePersistenceRecords>;
  /** Read-only metrics accessor. */
  public readonly metrics: MetricsRepository<SqlitePersistenceRecords>;

  /**
   * @param writer - The configured read-write connection (single writer).
   * @param reader - The configured read-only connection for queries.
   */
  private constructor(
    private readonly writer: SqliteConnection,
    private readonly reader: SqliteConnection,
    scope: TransactionScope<SqlitePersistenceRecords>,
  ) {
    this.transaction = scope;
    this.runs = new SqliteRunRepository(reader);
    this.problems = new SqliteProblemRepository(reader);
    this.benchmarks = new SqliteBenchmarkRepository(reader);
    this.metrics = new SqliteMetricsRepository(reader);
  }

  /**
   * Export the entire store as JSON Lines through `sink`. Read-only.
   *
   * @param sink - Receives each JSON Lines record.
   */
  public export(sink: JsonlSink): void {
    exportJsonl(this.reader, sink);
  }

  /** Close both connections. Safe to call once; idempotent at the driver seam. */
  public close(): void {
    this.reader.close();
    this.writer.close();
  }

  /**
   * Attach the store facade to already-open, configured connections.
   *
   * @internal Used by {@link openSqliteStore} after the safe-open sequence.
   */
  public static attach(
    writer: SqliteConnection,
    reader: SqliteConnection,
    config: SqliteStoreConfig,
  ): SqliteStore {
    const queue = new WriterQueue();
    const scope =
      config.busyRetry === undefined
        ? new SqliteTransactionScope(writer, queue)
        : new SqliteTransactionScope(
            writer,
            queue,
            config.busyRetry,
            config.sleep,
          );
    return new SqliteStore(writer, reader, scope);
  }
}

/**
 * Open a durable SQLite store, performing the full safe-open sequence.
 *
 * The steps run in a fixed order so the store is never handed out in an unsafe
 * state: (1) prove the path is on a local filesystem; (2) open the writer and
 * configure WAL/synchronous/foreign-keys/busy-timeout; (3) migrate to the current
 * schema (creating it on a fresh file); (4) verify integrity and cancel
 * interrupted runs; (5) optionally prune stale raw payloads; (6) open the
 * read-only query connection.
 *
 * @param config - The store configuration.
 * @returns The opened store.
 * @throws {DurabilityConfigError} If the path is non-local or WAL is unavailable.
 * @throws {SchemaVersionError} If the on-disk schema version is unknown.
 * @throws {IntegrityCheckError} If startup integrity verification fails.
 */
export function openSqliteStore(config: SqliteStoreConfig): SqliteStore {
  assertLocalFilesystem(config.path, config.filesystemProbe);

  const writer = openWriter(config.path);
  try {
    configureConnection(writer, "read-write");
    migrate(writer);
    runStartupRecovery(writer);
    if (config.retentionNow !== undefined) {
      applyRetention(writer, config.retentionNow);
    }
  } catch (error) {
    writer.close();
    throw error;
  }

  const reader = openReader(config.path);
  try {
    configureConnection(reader, "read-only");
  } catch (error) {
    reader.close();
    writer.close();
    throw error;
  }

  return SqliteStore.attach(writer, reader, config);
}
