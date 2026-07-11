/**
 * The SQLite {@link TransactionScope} — the single durable write seam.
 *
 * Every write in the adapter flows through here. `transact` funnels the caller
 * onto the process-local {@link WriterQueue} so at most one write transaction is
 * ever open, wraps the attempt in bounded busy-retry, and brackets the
 * caller-supplied unit of work in `BEGIN IMMEDIATE` … `COMMIT`. `BEGIN IMMEDIATE`
 * takes the write lock up front, so contention surfaces before any work runs
 * rather than at `COMMIT`. If the callback throws, the transaction is rolled back
 * and the failure is surfaced as a {@link TransactionAbortedError}, so a partial
 * write is never observable.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { TransactionScope, UnitOfWork } from "../ports/index.js";
import type { SqliteConnection } from "./connection.js";
import { TransactionAbortedError } from "./errors.js";
import type { SqlitePersistenceRecords } from "./rows.js";
import { SqliteUnitOfWork } from "./unit-of-work.js";
import type {
  BusyRetryOptions,
  Sleeper,
  WriterQueue,
} from "./writer-queue.js";
import { DEFAULT_BUSY_RETRY, withBusyRetry } from "./writer-queue.js";

/** A {@link TransactionScope} backed by one serialized writer connection. */
export class SqliteTransactionScope
  implements TransactionScope<SqlitePersistenceRecords>
{
  /**
   * @param db - The single writer connection all transactions run on.
   * @param queue - The process-local queue serializing every writer.
   * @param retry - Busy-retry bounds (defaults to {@link DEFAULT_BUSY_RETRY}).
   * @param sleep - Injectable delay for busy-retry (defaults to real timers).
   */
  public constructor(
    private readonly db: SqliteConnection,
    private readonly queue: WriterQueue,
    private readonly retry: BusyRetryOptions = DEFAULT_BUSY_RETRY,
    private readonly sleep?: Sleeper,
  ) {}

  /**
   * Execute `work` atomically against a fresh unit of work.
   *
   * @typeParam T - The value produced by the unit of work.
   * @param work - Callback receiving the transaction-scoped repositories.
   * @returns The value returned by `work`, once the transaction has committed.
   */
  public transact<T>(
    work: (uow: UnitOfWork<SqlitePersistenceRecords>) => Promise<T>,
  ): Promise<T> {
    return this.queue.enqueue(() =>
      this.sleep === undefined
        ? withBusyRetry(() => this.runOnce(work), this.retry)
        : withBusyRetry(() => this.runOnce(work), this.retry, this.sleep),
    );
  }

  /**
   * Run one full transaction attempt. A busy failure here is retried by the
   * enclosing {@link withBusyRetry}; any other callback failure aborts.
   */
  private async runOnce<T>(
    work: (uow: UnitOfWork<SqlitePersistenceRecords>) => Promise<T>,
  ): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = await work(new SqliteUnitOfWork(this.db));
    } catch (error) {
      this.rollbackQuietly();
      throw new TransactionAbortedError(error);
    }
    try {
      this.db.exec("COMMIT");
    } catch (error) {
      // A failed COMMIT leaves the transaction open; undo it so a retry (busy)
      // or the caller (other errors) starts from a clean slate.
      this.rollbackQuietly();
      throw error;
    }
    return result;
  }

  /** Roll back the open transaction, swallowing a "no transaction" error. */
  private rollbackQuietly(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // No active transaction (e.g. BEGIN itself failed) — nothing to undo.
    }
  }
}
