/**
 * Watch lifecycle state machine.
 *
 * The watch State literals and legal transitions are normative (see
 * `docs/architecture/design-patterns.md`). {@link WatchLifecycle} is an
 * immutable value object; each transition returns a new instance and illegal
 * transitions are rejected. A rescan while observing advances the watch
 * {@link Generation}, which downstream runs carry so that stale results are
 * discarded rather than committed.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

import { IllegalWatchTransitionError } from "./errors.js";
import type { Generation } from "./ids.js";
import { initialGeneration, nextGeneration } from "./ids.js";

/** The watch lifecycle states. */
export type WatchState = "stopped" | "starting" | "observing" | "draining";

/**
 * Legal watch transitions as an adjacency map: for each state, the set of
 * states it may move to.
 */
export const WATCH_TRANSITIONS: Readonly<
  Record<WatchState, readonly WatchState[]>
> = Object.freeze({
  stopped: ["starting"],
  starting: ["observing", "stopped"],
  observing: ["draining", "stopped"],
  draining: ["stopped"],
});

/**
 * An immutable snapshot of the watcher's lifecycle position and current
 * generation.
 *
 * Instances are frozen. Transition methods never mutate the receiver; they
 * return a new {@link WatchLifecycle} or throw.
 */
export class WatchLifecycle {
  private constructor(
    /** The current watch state. */
    public readonly state: WatchState,
    /** The current watch generation. */
    public readonly generation: Generation,
  ) {
    Object.freeze(this);
  }

  /**
   * Create a watcher in the `stopped` state at the initial generation.
   *
   * @returns A stopped {@link WatchLifecycle}.
   */
  public static stopped(): WatchLifecycle {
    return new WatchLifecycle("stopped", initialGeneration());
  }

  /**
   * Move to `target` if the transition is legal, preserving the generation.
   *
   * @param target - The state to transition to.
   * @returns A new {@link WatchLifecycle} in `target`.
   * @throws {IllegalWatchTransitionError} If the transition is not permitted.
   */
  public to(target: WatchState): WatchLifecycle {
    if (!WATCH_TRANSITIONS[this.state].includes(target)) {
      throw new IllegalWatchTransitionError(this.state, target);
    }
    return new WatchLifecycle(target, this.generation);
  }

  /** `stopped -> starting`. */
  public start(): WatchLifecycle {
    return this.to("starting");
  }

  /** `starting -> observing`. */
  public observe(): WatchLifecycle {
    return this.to("observing");
  }

  /** `observing -> draining`. */
  public drain(): WatchLifecycle {
    return this.to("draining");
  }

  /** Transition to `stopped` from any state that permits it. */
  public stop(): WatchLifecycle {
    return this.to("stopped");
  }

  /**
   * Advance to the next generation in response to a rescan.
   *
   * Only legal while `observing`; a rescan does not change the state but bumps
   * the generation so that in-flight results from the prior generation become
   * stale.
   *
   * @returns A new {@link WatchLifecycle} at the next generation.
   * @throws {IllegalWatchTransitionError} If not currently `observing`.
   */
  public rescan(): WatchLifecycle {
    if (this.state !== "observing") {
      throw new IllegalWatchTransitionError(this.state, "observing");
    }
    return new WatchLifecycle(this.state, nextGeneration(this.generation));
  }
}
