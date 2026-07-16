/**
 * Public surface of the pure domain layer.
 *
 * The domain defines the adapter-free contracts and state machines that flow
 * across ports: execution statuses, run/watch lifecycles, and immutable value
 * types. It imports no adapter, CLI, Node, or third-party module. Downstream
 * layers import from this barrel rather than reaching into individual files.
 */

// Identity and generation values.
export type { CaseId, Generation, RunId } from "./ids.js";
export {
  initialGeneration,
  isNewerGeneration,
  nextGeneration,
  toCaseId,
  toRunId,
} from "./ids.js";

// Execution statuses and precedence.
export type { ExecutionStatus, TerminationCause } from "./status.js";
export {
  compareStatusPrecedence,
  EXECUTION_STATUS_PRECEDENCE,
  isTerminationCause,
  mostSevere,
  statusSeverityRank,
} from "./status.js";

// Resource limits.
export type { ResourceLimits, ResourceLimitsSpec } from "./limits.js";
export { createResourceLimits } from "./limits.js";

// Execution request and raw result.
export type {
  BoundedOutput,
  ExecutionRequest,
  ImplementationRef,
  ImplementationRole,
  RawProcessResult,
  ResourceObservations,
  TerminationKind,
} from "./execution.js";

// Comparison policy and result.
export type {
  ComparisonMismatch,
  ComparisonPolicy,
  ComparisonResult,
  EqualityMode,
  NumericTolerance,
} from "./comparison.js";

// Run lifecycle and records.
export type {
  PersistableRun,
  RunQuery,
  RunState,
  TerminalRunState,
} from "./run.js";
