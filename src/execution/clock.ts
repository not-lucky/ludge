/**
 * Clock port.
 *
 * A {@link Clock} separates two distinct notions of time so callers pick the
 * right one: a monotonic source for measuring durations (immune to wall-clock
 * adjustments) and a wall-clock source for human-facing, persisted timestamps.
 * Injecting the clock keeps time deterministic and controllable in tests.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/**
 * Provides monotonic and wall-clock time.
 *
 * The clock is shared infrastructure, not backend-specific, so it carries no
 * coherence tag.
 */
export interface Clock {
  /**
   * A monotonically non-decreasing nanosecond counter for measuring elapsed
   * time. Only differences are meaningful; the origin is arbitrary. Returned as
   * a `bigint` to preserve nanosecond precision without floating-point loss.
   *
   * @returns The current monotonic reading in nanoseconds.
   */
  monotonicNs(): bigint;
  /**
   * The current wall-clock time as ISO-8601 UTC text (with a `Z` offset).
   *
   * @returns The current UTC timestamp.
   */
  wallTimeUtc(): string;
}
