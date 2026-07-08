/**
 * Transaction port for the persistence layer — the write seam.
 *
 * This is the ONLY place where repository writes become durable, and they do so
 * atomically. Every write issued by the repositories inside a single `transact`
 * callback commits together or rolls back together, so a run and all of its
 * child records (cases, executions, benchmark samples/aggregates, metrics) form
 * one atomic unit. This is the "writes go through the transaction port" seam the
 * spec refers to.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

import type { PersistenceRecords } from "./records.js";
import type {
  BenchmarkRepository,
  MetricsRepository,
  ProblemRepository,
  RunRepository,
} from "./repositories.js";

/**
 * The set of repositories available within a single transaction.
 *
 * A unit of work groups the repositories so all writes made through them share
 * the same transactional boundary. It is generic over the record bundle so the
 * task-deferred repositories carry their refined shapes through unchanged.
 *
 * @typeParam R - The persistence record bundle fixing the concrete shapes.
 */
export interface UnitOfWork<R extends PersistenceRecords> {
  /** Runs repository, scoped to the current transaction. */
  readonly runs: RunRepository;
  /** Problems repository, scoped to the current transaction. */
  readonly problems: ProblemRepository<R>;
  /** Benchmarks repository, scoped to the current transaction. */
  readonly benchmarks: BenchmarkRepository<R>;
  /** Metrics repository, scoped to the current transaction. */
  readonly metrics: MetricsRepository<R>;
}

/**
 * Port that runs a unit of work inside an atomic transaction.
 *
 * `transact` opens a transaction, hands the caller a {@link UnitOfWork}, and
 * commits every write issued through it once `work` resolves. If `work` throws
 * (or rejects), the entire transaction rolls back and no write is persisted, so
 * partial state can never be observed. The callback's return value is passed
 * through on success.
 *
 * @typeParam R - The persistence record bundle fixing the concrete shapes.
 */
export interface TransactionScope<R extends PersistenceRecords> {
  /**
   * Execute `work` atomically against a fresh unit of work.
   *
   * @typeParam T - The value produced by the unit of work.
   * @param work - Callback receiving the transaction-scoped repositories; all
   *   writes it issues commit together, or roll back together if it throws.
   * @returns The value returned by `work`, once the transaction has committed.
   */
  transact<T>(work: (uow: UnitOfWork<R>) => Promise<T>): Promise<T>;
}
