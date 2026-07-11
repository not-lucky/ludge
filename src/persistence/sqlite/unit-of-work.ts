/**
 * The transaction-scoped {@link UnitOfWork} for the SQLite adapter.
 *
 * A unit of work bundles the four repositories, all bound to the *same* writer
 * connection, so every write a `transact` callback issues through them lands in
 * the one open transaction and commits or rolls back together. The scope
 * ({@link module:./transaction-scope.js}) constructs a fresh unit of work per
 * transaction; the repositories hold no transaction state of their own, so
 * reusing one connection is all it takes to share the boundary.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { UnitOfWork } from "../ports/index.js";
import type { SqliteConnection } from "./connection.js";
import { SqliteBenchmarkRepository } from "./repositories/benchmark-repository.js";
import { SqliteMetricsRepository } from "./repositories/metrics-repository.js";
import { SqliteProblemRepository } from "./repositories/problem-repository.js";
import { SqliteRunRepository } from "./repositories/run-repository.js";
import type { SqlitePersistenceRecords } from "./rows.js";

/** A {@link UnitOfWork} whose repositories share one writer connection. */
export class SqliteUnitOfWork implements UnitOfWork<SqlitePersistenceRecords> {
  /** Runs repository, scoped to the current transaction. */
  public readonly runs: SqliteRunRepository;
  /** Problems repository, scoped to the current transaction. */
  public readonly problems: SqliteProblemRepository;
  /** Benchmarks repository, scoped to the current transaction. */
  public readonly benchmarks: SqliteBenchmarkRepository;
  /** Metrics repository, scoped to the current transaction. */
  public readonly metrics: SqliteMetricsRepository;

  /**
   * @param db - The writer connection whose open transaction all writes join.
   */
  public constructor(db: SqliteConnection) {
    this.runs = new SqliteRunRepository(db);
    this.problems = new SqliteProblemRepository(db);
    this.benchmarks = new SqliteBenchmarkRepository(db);
    this.metrics = new SqliteMetricsRepository(db);
  }
}
