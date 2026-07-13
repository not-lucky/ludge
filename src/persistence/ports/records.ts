/**
 * Record-shape aggregate for the persistence ports.
 *
 * This module fixes only the *contract*, not the concrete row shapes. The
 * repository and transaction ports are generic over a single knob
 * `R extends PersistenceRecords`, so later tasks can refine the stored shapes
 * without touching the port signatures. It is a deliberate deferral seam: task
 * 03 owns the ports, while tasks 09 (SQLite), 16 (benchmark), and 10 (metrics)
 * own the records that flow through them.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/**
 * The bundle of record shapes owned by later tasks, exposed as generic slots.
 *
 * Each field is intentionally `unknown` here: task 03 must not know the concrete
 * persisted shapes, only the distinct record kinds. A downstream
 * task refines every slot at once by declaring an extending interface, e.g. task
 * 09 introduces
 *
 * ```ts
 * interface SqlitePersistenceRecords extends PersistenceRecords {
 *   readonly problem: ProblemRow;
 *   readonly implementation: ImplementationRow;
 *   readonly case: CaseRow;
 *   readonly execution: ExecutionRow;
 *   readonly artifact: ArtifactRow;
 *   readonly benchmarkSample: BenchmarkSampleRow;
 *   readonly benchmarkAggregate: BenchmarkAggregateRow;
 *   readonly metric: DailyMetricRow;
 * }
 * ```
 *
 * Bundling all shapes into one type parameter keeps the repositories and the
 * transaction port generic over a single knob (`R extends PersistenceRecords`)
 * rather than threading four independent type parameters through every port.
 */
export interface PersistenceRecords {
  /** The persisted problem record shape (refined by task 09). */
  readonly problem: unknown;
  /** The persisted implementation record shape (refined by task 12). */
  readonly implementation: unknown;
  /** The persisted per-run case record shape (refined by task 12). */
  readonly case: unknown;
  /** The persisted per-case execution record shape (refined by task 12). */
  readonly execution: unknown;
  /** The persisted artifact record shape (refined by task 12). */
  readonly artifact: unknown;
  /** The immutable replay-link record shape (refined by task 13). */
  readonly replay: unknown;
  /** The persisted per-sample benchmark record shape (refined by task 16). */
  readonly benchmarkSample: unknown;
  /** The persisted aggregated benchmark record shape (refined by task 16). */
  readonly benchmarkAggregate: unknown;
  /** The persisted daily metric record shape (refined by task 10). */
  readonly metric: unknown;
}
