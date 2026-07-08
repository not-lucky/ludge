/**
 * Repository ports for the persistence layer.
 *
 * Each repository is a Collection-style port over one aggregate. Reads are
 * read-only queries; writes exist here too, but their *atomic* execution is not
 * a repository concern — it is coordinated by the transaction port
 * (see `./transaction.js`), so a run and its child records commit or roll back
 * together. Every port that stores task-owned shapes is generic over one knob
 * `R extends PersistenceRecords`, deferring the concrete row types to later
 * tasks. Listing methods return an `AsyncIterable` so persistence can stream
 * rows (the Iterator pattern) rather than materialize an unbounded result set.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

import type { PersistableRun, RunId, RunQuery } from "../../domain/index.js";
import type { PersistenceRecords } from "./records.js";

/**
 * Port for persisting and querying completed runs.
 *
 * Unlike the other repositories, the run shape is fully domain-typed
 * ({@link PersistableRun}) because the run Memento is a domain contract, not a
 * task-deferred record. The `commit` write is durable only when performed inside
 * a transaction scope, where it is made atomic with the run's child records.
 */
export interface RunRepository {
  /**
   * Persist a completed run snapshot.
   *
   * Durability and atomicity are provided by the enclosing transaction: this
   * call only becomes permanent when its `transact` callback resolves.
   *
   * @param run - The immutable run Memento to store.
   */
  commit(run: PersistableRun): Promise<void>;

  /**
   * Look up a single run by its identity. Read-only query.
   *
   * @param runId - The run to fetch.
   * @returns The stored run, or `null` when no such run exists.
   */
  findById(runId: RunId): Promise<PersistableRun | null>;

  /**
   * Stream stored runs matching a query. Read-only query.
   *
   * Returns an `AsyncIterable` so callers consume rows incrementally and the
   * store never has to buffer an unbounded result set in memory.
   *
   * @param query - Filters to apply; absent fields impose no filter.
   * @returns An async stream of matching runs.
   */
  list(query: RunQuery): AsyncIterable<PersistableRun>;
}

/**
 * Port for registering and querying problems.
 *
 * The stored problem shape is deferred to task 09 via `R["problem"]`. The
 * `register` write becomes durable only within a transaction scope.
 *
 * @typeParam R - The persistence record bundle fixing the concrete shapes.
 */
export interface ProblemRepository<R extends PersistenceRecords> {
  /**
   * Persist (register) a problem record.
   *
   * Durability and atomicity are provided by the enclosing transaction.
   *
   * @param problem - The problem record to store.
   */
  register(problem: R["problem"]): Promise<void>;

  /**
   * Look up a problem by its slug. Read-only query.
   *
   * @param slug - The unique problem slug.
   * @returns The stored problem, or `null` when none matches.
   */
  findBySlug(slug: string): Promise<R["problem"] | null>;

  /**
   * Stream all registered problems. Read-only query.
   *
   * Returns an `AsyncIterable` so rows are streamed rather than fully buffered.
   *
   * @returns An async stream of problem records.
   */
  list(): AsyncIterable<R["problem"]>;
}

/**
 * Port for persisting and querying benchmark samples and aggregates.
 *
 * Both stored shapes are deferred to task 16 via `R["benchmarkSample"]` and
 * `R["benchmarkAggregate"]`. Writes become durable only within a transaction
 * scope, where individual samples and their aggregate commit atomically with the
 * owning run.
 *
 * @typeParam R - The persistence record bundle fixing the concrete shapes.
 */
export interface BenchmarkRepository<R extends PersistenceRecords> {
  /**
   * Persist a single benchmark sample.
   *
   * Durability and atomicity are provided by the enclosing transaction.
   *
   * @param sample - The per-sample benchmark record to store.
   */
  commitSample(sample: R["benchmarkSample"]): Promise<void>;

  /**
   * Persist a benchmark aggregate.
   *
   * Durability and atomicity are provided by the enclosing transaction.
   *
   * @param aggregate - The aggregated benchmark record to store.
   */
  commitAggregate(aggregate: R["benchmarkAggregate"]): Promise<void>;

  /**
   * Stream all samples recorded for a run. Read-only query.
   *
   * Returns an `AsyncIterable` so sample rows are streamed rather than buffered.
   *
   * @param runId - The run whose samples to stream.
   * @returns An async stream of sample records.
   */
  listSamples(runId: RunId): AsyncIterable<R["benchmarkSample"]>;

  /**
   * Look up the aggregate for a run. Read-only query.
   *
   * @param runId - The run whose aggregate to fetch.
   * @returns The stored aggregate, or `null` when none exists.
   */
  findAggregate(runId: RunId): Promise<R["benchmarkAggregate"] | null>;
}

/**
 * Port for persisting and querying rolled-up daily metrics.
 *
 * The stored metric shape is deferred to task 10 via `R["metric"]`. The
 * `upsertDaily` write becomes durable only within a transaction scope.
 *
 * @typeParam R - The persistence record bundle fixing the concrete shapes.
 */
export interface MetricsRepository<R extends PersistenceRecords> {
  /**
   * Insert or update the metric record for a day.
   *
   * Upsert semantics keep a single row per day so repeated rollups are
   * idempotent. Durability and atomicity are provided by the enclosing
   * transaction.
   *
   * @param metric - The daily metric record to store.
   */
  upsertDaily(metric: R["metric"]): Promise<void>;

  /**
   * Stream all stored daily metrics. Read-only query.
   *
   * Returns an `AsyncIterable` so rows are streamed rather than fully buffered.
   *
   * @returns An async stream of metric records.
   */
  list(): AsyncIterable<R["metric"]>;
}
