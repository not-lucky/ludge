/**
 * Execution request and raw-result value contracts.
 *
 * {@link ExecutionRequest} is the immutable input handed to the sandbox port;
 * {@link RawProcessResult} is the bounded, adapter-neutral observation returned
 * by it. Neither type performs I/O — they are the data that flows across the
 * process boundary described in `docs/architecture/system.md`.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

import type { CaseId, Generation, RunId } from "./ids.js";
import type { ResourceLimits } from "./limits.js";

/** The role a Python script plays in a run. */
export type ImplementationRole = "solution" | "naive" | "generator";

/**
 * An immutable reference to a target implementation script.
 *
 * The domain never reads or evaluates the file; it only names it so that an
 * adapter can locate and launch it under the sandbox.
 */
export interface ImplementationRef {
  /** The role this implementation plays (solution, reference, generator). */
  readonly role: ImplementationRole;
  /** Problem-root-relative path to the script (never an absolute host path). */
  readonly relativePath: string;
}

/**
 * An immutable, self-contained description of one execution.
 *
 * It bundles the run/case identity, the target implementation, the encoded
 * input reference, the codec versions used to frame values, the resource limits,
 * and the watch generation the request belongs to. All references are values;
 * no live process or handle is captured.
 */
export interface ExecutionRequest {
  /** Identity of the owning run. */
  readonly runId: RunId;
  /** Identity of the case being executed. */
  readonly caseId: CaseId;
  /** Stable fingerprint/slug of the problem the case belongs to. */
  readonly problemFingerprint: string;
  /** The implementation to launch. */
  readonly implementation: ImplementationRef;
  /** Canonical, already-encoded request input bytes (identical across impls). */
  readonly inputBytes: Uint8Array;
  /** Version identifier of the codec used to encode the input. */
  readonly inputCodecVersion: string;
  /** Version identifier of the codec expected for the response output. */
  readonly outputCodecVersion: string;
  /** Resource ceilings for this execution. */
  readonly limits: ResourceLimits;
  /** Watch generation this request belongs to; guards against stale commits. */
  readonly generation: Generation;
}

/** How a target process ultimately terminated. */
export type TerminationKind =
  | "exited"
  | "signaled"
  | "timed_out"
  | "killed"
  | "spawn_failed";

/**
 * Bounded capture of a single output stream.
 *
 * `data` holds at most the configured ceiling of bytes; `truncated` records
 * whether more bytes were produced than captured, and `totalBytes` is the full
 * observed length before truncation.
 */
export interface BoundedOutput {
  /** The captured (possibly truncated) bytes. */
  readonly data: Uint8Array;
  /** Whether output exceeded the capture ceiling and was cut off. */
  readonly truncated: boolean;
  /** Total number of bytes observed, including any dropped past the ceiling. */
  readonly totalBytes: number;
}

/**
 * Resource observations sampled by the supervisor during and after execution.
 *
 * These are measurements, not verdicts; status normalization interprets them.
 */
export interface ResourceObservations {
  /** Measured wall-clock duration in milliseconds. */
  readonly wallTimeMs: number;
  /** Measured CPU time in milliseconds. */
  readonly cpuTimeMs: number;
  /** Peak descendant cgroup memory in bytes. */
  readonly memoryPeakBytes: number;
  /** Count of cgroup OOM-kill events observed. */
  readonly oomKills: number;
  /** Peak live process count observed. */
  readonly peakProcessCount: number;
}

/**
 * The bounded, adapter-neutral result of one execution.
 *
 * It preserves the raw exit code, signal, bounded stdout/stderr with truncation
 * flags, the resource cause and observations, and any cleanup diagnostics —
 * regardless of the status that normalization later assigns.
 */
export interface RawProcessResult {
  /** How the process terminated. */
  readonly termination: TerminationKind;
  /** Raw process exit code, or `null` when terminated by signal or not spawned. */
  readonly exitCode: number | null;
  /** Terminating signal name (e.g. `"SIGKILL"`), or `null` when exited normally. */
  readonly signal: string | null;
  /** Bounded stdout capture. */
  readonly stdout: BoundedOutput;
  /** Bounded stderr capture. */
  readonly stderr: BoundedOutput;
  /** Sampled resource observations. */
  readonly resources: ResourceObservations;
  /** Non-fatal cleanup diagnostics (e.g. cgroup removal warnings). */
  readonly cleanupDiagnostics: readonly string[];
}
