/**
 * The transaction-scoped {@link UnitOfWork} for the SQLite adapter.
 *
 * A unit of work bundles its repositories and transaction-only writers, all
 * bound to the *same* writer connection, so every write a `transact` callback
 * issues through them lands in
 * the one open transaction and commits or rolls back together. The scope
 * ({@link module:./transaction-scope.js}) constructs a fresh unit of work per
 * transaction; the repositories hold no transaction state of their own, so
 * reusing one connection is all it takes to share the boundary.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { SqliteConnection } from "./connection.js";
import { SqliteArtifactRepository } from "./repositories/artifact-repository.js";
import { SqliteBenchmarkRepository } from "./repositories/benchmark-repository.js";
import { SqliteCaseRepository } from "./repositories/case-repository.js";
import { SqliteExecutionRepository } from "./repositories/execution-repository.js";
import { SqliteEnvironmentRepository } from "./repositories/environment-repository.js";
import { SqliteImplementationRepository } from "./repositories/implementation-repository.js";
import { SqliteMetricsRepository } from "./repositories/metrics-repository.js";
import { SqliteProblemRepository } from "./repositories/problem-repository.js";
import { SqliteReplayRepository } from "./repositories/replay-repository.js";
import { SqliteRunRepository } from "./repositories/run-repository.js";

/** Concrete transaction methods sharing one writer connection. */
export class SqliteTransaction {
  /** Runs repository, scoped to the current transaction. */
  public readonly runs: SqliteRunRepository;
  /** Problems repository, scoped to the current transaction. */
  public readonly problems: SqliteProblemRepository;
  /** Implementation writer, scoped to the current transaction. */
  public readonly implementations: SqliteImplementationRepository;
  /** Case writer, scoped to the current transaction. */
  public readonly cases: SqliteCaseRepository;
  /** Execution writer, scoped to the current transaction. */
  public readonly executions: SqliteExecutionRepository;
  /** Artifact writer, scoped to the current transaction. */
  public readonly artifacts: SqliteArtifactRepository;
  /** Immutable replay links, scoped to the current transaction. */
  public readonly replays: SqliteReplayRepository;
  /** Benchmark environment records, scoped to the current transaction. */
  public readonly environments: SqliteEnvironmentRepository;
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
    this.implementations = new SqliteImplementationRepository(db);
    this.cases = new SqliteCaseRepository(db);
    this.executions = new SqliteExecutionRepository(db);
    this.artifacts = new SqliteArtifactRepository(db);
    this.replays = new SqliteReplayRepository(db);
    this.environments = new SqliteEnvironmentRepository(db);
    this.benchmarks = new SqliteBenchmarkRepository(db);
    this.metrics = new SqliteMetricsRepository(db);
  }
}
