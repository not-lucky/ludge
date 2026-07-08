/**
 * Profiler port.
 *
 * A {@link Profiler} measures a single execution and produces a profiling
 * record. It is layered as a Decorator around the sandbox run: it records
 * timing and resource facts without influencing the verdict. The concrete
 * profiling record shape is owned by task 10, so it is a generic parameter
 * here.
 *
 * This module is pure: it declares contracts only and imports no runtime,
 * adapter, or Node module (only domain value types).
 */

import type { RawProcessResult } from "../../domain/index.js";

/**
 * An open profiling measurement for one execution.
 *
 * A scope is opened just before the execution begins and finished once the
 * process has terminated, at which point the observed {@link RawProcessResult}
 * is folded in to yield the profiling record.
 *
 * @typeParam TProfile - The profiling record produced (task 10).
 */
export interface ProfileScope<TProfile> {
  /**
   * Finish the measurement and produce the profiling record.
   *
   * @param raw - The terminated process observation to fold in.
   * @returns The completed profiling record.
   */
  finish(raw: RawProcessResult): TProfile;
}

/**
 * Opens per-execution profiling scopes.
 *
 * The `Tag` brand keeps the profiler bound to the {@link RuntimeBundle} that
 * produced it, so it cannot be mixed with a foreign launcher + codec at the
 * type level.
 *
 * @typeParam TProfile - The profiling record produced (task 10).
 * @typeParam Tag - The owning backend's coherence tag.
 */
export interface Profiler<TProfile, Tag extends string = string> {
  /** The backend this profiler belongs to; enforces bundle coherence. */
  readonly backendId: Tag;
  /**
   * Begin measuring a new execution.
   *
   * @returns An open {@link ProfileScope} to finish when the process ends.
   */
  begin(): ProfileScope<TProfile>;
}
