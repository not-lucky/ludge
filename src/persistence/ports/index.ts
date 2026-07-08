/**
 * Public surface of the persistence ports.
 *
 * These are the adapter-free, type-only contracts through which the application
 * reads and writes durable state: the record-shape aggregate, the per-aggregate
 * repositories, and the transaction port that makes writes atomic. Concrete
 * adapters (e.g. the SQLite store in task 09) implement these interfaces;
 * downstream layers depend on this barrel rather than on any adapter.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

// Record-shape aggregate (deferral seam for task-owned shapes).
export type { PersistenceRecords } from "./records.js";

// Per-aggregate repository ports.
export type {
  BenchmarkRepository,
  MetricsRepository,
  ProblemRepository,
  RunRepository,
} from "./repositories.js";

// Atomic write seam.
export type { TransactionScope, UnitOfWork } from "./transaction.js";
