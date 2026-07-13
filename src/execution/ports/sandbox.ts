/**
 * Sandbox port.
 *
 * A {@link Sandbox} runs a single {@link ArgvInvocation} under a set of
 * {@link ResourceLimits}, supervises its lifecycle, and returns a bounded,
 * adapter-neutral {@link RawProcessResult}. The target always executes as a
 * child process outside the TypeScript process; the sandbox never imports or
 * evaluates target code. Output caps, timeout observation, profiling, and
 * telemetry are layered around this port as Decorators without changing the
 * verdict policy.
 *
 * This module is pure: it declares a contract only and imports no runtime,
 * adapter, or Node module (only domain value types and sibling ports).
 */

import type { RawProcessResult, ResourceLimits } from "../../domain/index.js";
import type { CancellationToken } from "./cancellation.js";
import type { ArgvInvocation } from "./invocation.js";

/**
 * Executes a target invocation under enforced resource limits.
 *
 * `run` resolves with a {@link RawProcessResult} for every terminated process —
 * including nonzero exits, signals, and limit breaches — rather than throwing;
 * status normalization interprets the result later. The `Tag` brand keeps the
 * sandbox bound to the {@link RuntimeBundle} that produced it, so an
 * incompatible sandbox cannot be mixed with a foreign launcher + codec at the
 * type level.
 *
 * @typeParam Tag - The owning backend's coherence tag.
 */
export interface Sandbox<Tag extends string = string> {
  /** The backend this sandbox belongs to; enforces bundle coherence. */
  readonly backendId: Tag;
  /**
   * Run `invocation` under `limits`, observing `cancellation`.
   *
   * @param invocation - The direct, non-shell invocation to launch.
   * @param limits - The resource ceilings to enforce.
   * @param cancellation - Cooperative signal to abort the run promptly.
   * @returns The bounded observation of the terminated process.
   */
  run(
    invocation: ArgvInvocation,
    /** Exact canonical request-envelope bytes supplied to target stdin. */
    input: Uint8Array,
    limits: ResourceLimits,
    cancellation: CancellationToken,
  ): Promise<RawProcessResult>;
}
