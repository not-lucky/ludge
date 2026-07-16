/** Execution profiling records built from bounded sandbox observations. */

import type {
  ExecutionStatus,
  RawProcessResult,
  TerminationCause,
} from "../domain/index.js";
import type { Clock } from "../execution/clock.js";

interface ProfileScope<T> {
  finish(raw: RawProcessResult): T;
}

interface Profiler<T> {
  begin(): ProfileScope<T>;
}

/** Version for persisted and evented execution profiling records. */
export const EXECUTION_PROFILE_SCHEMA_VERSION = 1 as const;

/** Normalized facts supplied after verdict/status classification. */
export interface ExecutionProfileOutcome {
  /** Stable normalized status for the execution, or `null` before classification. */
  readonly status: ExecutionStatus | null;
  /** Resource limit that caused termination, when one is known. */
  readonly limitCause: TerminationCause | null;
}

/**
 * Versioned, redaction-safe metrics for one child execution.
 *
 * Values unavailable from the current backend are `null`; a measured zero stays
 * `0`. Captured stdout/stderr are intentionally excluded: only their bounded
 * byte counts and truncation facts are profile data.
 */
export interface ExecutionProfile {
  /** Version of this profiling record. */
  readonly schemaVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  /** Launcher-to-child-spawn duration, or `null` when not instrumented. */
  readonly spawnDurationNs: number | null;
  /** Sandbox setup duration, or `null` when not instrumented. */
  readonly sandboxSetupDurationNs: number | null;
  /** Sandbox teardown duration, or `null` when not instrumented. */
  readonly sandboxTeardownDurationNs: number | null;
  /** Total observed child wall time. */
  readonly wallDurationNs: number | null;
  /** Child user CPU time, or `null` when the backend cannot split CPU time. */
  readonly cpuUserNs: number | null;
  /** Child system CPU time, or `null` when the backend cannot split CPU time. */
  readonly cpuSystemNs: number | null;
  /** Aggregate child/cgroup CPU time, or `null` when unavailable. */
  readonly cpuTotalNs: number | null;
  /** Process RSS peak, or `null` when unavailable. */
  readonly peakRssBytes: number | null;
  /** Cgroup memory peak, or `null` when unavailable. */
  readonly peakCgroupBytes: number | null;
  /** Total stdout bytes observed before capture truncation. */
  readonly stdoutBytes: number | null;
  /** Whether stdout was capped. */
  readonly stdoutTruncated: boolean | null;
  /** Total stderr bytes observed before capture truncation. */
  readonly stderrBytes: number | null;
  /** Whether stderr was capped. */
  readonly stderrTruncated: boolean | null;
  /** Bytes supplied to the child, or `null` when not instrumented. */
  readonly inputBytes: number | null;
  /** Child PID, or `null` when not recorded. */
  readonly childPid: number | null;
  /** Peak count of processes in the child cgroup. */
  readonly peakProcessCount: number | null;
  /** Child exit code, or `null` when it did not exit normally. */
  readonly exitCode: number | null;
  /** Signal that terminated the child, or `null`. */
  readonly terminatingSignal: string | null;
  /** Cgroup counters available from the backend. */
  readonly cgroupEvents: Readonly<{ oomKills: number | null }>;
  /** Stable classified outcome, or `null` until an orchestrator provides it. */
  readonly status: ExecutionStatus | null;
  /** Limit responsible for a classified resource failure, or `null`. */
  readonly limitCause: TerminationCause | null;
}

/** Optional known facts unavailable from the current `RawProcessResult` contract. */
export interface ExecutionProfileFacts {
  readonly spawnDurationNs?: number | null;
  readonly sandboxSetupDurationNs?: number | null;
  readonly sandboxTeardownDurationNs?: number | null;
  readonly inputBytes?: number | null;
  readonly childPid?: number | null;
  readonly cpuUserNs?: number | null;
  readonly cpuSystemNs?: number | null;
  readonly peakRssBytes?: number | null;
}

/** Create a concrete execution profiler coherent with a backend identifier. */
export function createExecutionProfiler(
  clock: Clock,
  outcome: ExecutionProfileOutcome = { status: null, limitCause: null },
  facts: ExecutionProfileFacts = {},
): Profiler<ExecutionProfile> {
  return {
    begin(): ProfileScope<ExecutionProfile> {
      const startedNs = clock.monotonicNs();
      return {
        finish(raw: RawProcessResult): ExecutionProfile {
          // The wall metric from the sandbox is authoritative for child runtime;
          // the local scope only establishes the profiler's non-invasive span.
          void startedNs;
          return Object.freeze({
            schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
            spawnDurationNs: facts.spawnDurationNs ?? null,
            sandboxSetupDurationNs: facts.sandboxSetupDurationNs ?? null,
            sandboxTeardownDurationNs: facts.sandboxTeardownDurationNs ?? null,
            wallDurationNs: millisecondsToNs(raw.resources.wallTimeMs),
            cpuUserNs: facts.cpuUserNs ?? null,
            cpuSystemNs: facts.cpuSystemNs ?? null,
            cpuTotalNs: millisecondsToNs(raw.resources.cpuTimeMs),
            peakRssBytes: facts.peakRssBytes ?? null,
            peakCgroupBytes: raw.resources.memoryPeakBytes,
            stdoutBytes: raw.stdout.totalBytes,
            stdoutTruncated: raw.stdout.truncated,
            stderrBytes: raw.stderr.totalBytes,
            stderrTruncated: raw.stderr.truncated,
            inputBytes: facts.inputBytes ?? null,
            childPid: facts.childPid ?? null,
            peakProcessCount: raw.resources.peakProcessCount,
            exitCode: raw.exitCode,
            terminatingSignal: raw.signal,
            cgroupEvents: Object.freeze({ oomKills: raw.resources.oomKills }),
            status: outcome.status,
            limitCause: outcome.limitCause,
          });
        },
      };
    },
  };
}

function millisecondsToNs(milliseconds: number): number | null {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const nanoseconds = milliseconds * 1_000_000;
  return Number.isSafeInteger(nanoseconds) ? nanoseconds : null;
}
