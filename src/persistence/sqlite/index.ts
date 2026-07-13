/**
 * Public surface of the SQLite persistence adapter.
 *
 * Callers wire the store and depend on the persistence *ports* for behavior; the
 * concrete row shapes, error taxonomy, and a few stable labels/versions are the
 * only implementation types they legitimately need. Internal machinery — the
 * connection seam, writer queue, mappers, row I/O, schema DDL, durability
 * pragmas, filesystem probe, recovery, retention, and export internals — is
 * deliberately *not* re-exported, matching the sibling barrels (a caller depends
 * on the store + ports, never on the adapter's guts).
 *
 * This module is a pure re-export barrel; it holds no runtime of its own.
 */

// The store facade and its factory — the wiring entry point.
export { SqliteStore, openSqliteStore } from "./store.js";
export type { SqliteStoreConfig } from "./store.js";

// The error taxonomy callers branch on (durability config → CLI exit path, etc).
export {
  DurabilityConfigError,
  IntegrityCheckError,
  PersistenceBusyError,
  PersistenceError,
  SchemaVersionError,
  TransactionAbortedError,
} from "./errors.js";
export type { PersistenceErrorReason } from "./errors.js";

// The concrete record bundle the store is instantiated at.
export type {
  BenchmarkAggregateRow,
  BenchmarkSampleRow,
  ArtifactRow,
  CaseRow,
  DailyMetricRow,
  ExecutionRow,
  ImplementationRow,
  ProblemRow,
  ReplayRow,
  RunRow,
  SqliteBool,
  SqlitePersistenceRecords,
} from "./rows.js";

// Stable labels and versions surfaced in reports and the environment record.
export { SCHEMA_VERSION } from "./schema.js";
export { DATABASE_MODE } from "./durability.js";
export { EXPORT_FORMAT_VERSION } from "./export.js";
export type { JsonlSink } from "./export.js";

// Transaction-only writer implementations, for adapter-level composition/tests.
export { SqliteArtifactRepository } from "./repositories/artifact-repository.js";
export { SqliteArtifactReaderRepository } from "./repositories/artifact-reader-repository.js";
export { SqliteReplayRepository } from "./repositories/replay-repository.js";
export { SqliteCaseRepository } from "./repositories/case-repository.js";
export { SqliteExecutionRepository } from "./repositories/execution-repository.js";
export { SqliteImplementationRepository } from "./repositories/implementation-repository.js";
export { SqliteUnitOfWork } from "./unit-of-work.js";
