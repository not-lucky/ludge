/**
 * Run lifecycle state machine and run-record contracts.
 *
 * The run State literals and legal transitions are normative (see
 * `docs/architecture/design-patterns.md`). {@link RunLifecycle} is an immutable
 * value object: each transition returns a new instance, illegal transitions are
 * rejected, terminal states cannot mutate, and a result from an older watch
 * generation can never transition or commit a run that has advanced.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

import { IllegalRunTransitionError, StaleGenerationError } from "./errors.js";
import type { Generation, RunId } from "./ids.js";
import { isNewerGeneration } from "./ids.js";
import type { ResourceLimits } from "./limits.js";
import type { ExecutionStatus } from "./status.js";

/** The run lifecycle states. */
export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "canceling"
  | "completed"
  | "failed"
  | "canceled";

/** The terminal run states, from which no further transition is legal. */
export type TerminalRunState = "completed" | "failed" | "canceled";

/**
 * Legal run transitions as an adjacency map: for each state, the set of states
 * it may move to. Terminal states map to an empty set.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> =
  Object.freeze({
    queued: ["starting"],
    starting: ["running", "failed", "canceled"],
    running: ["completed", "failed", "canceling"],
    canceling: ["canceled", "failed"],
    completed: [],
    failed: [],
    canceled: [],
  });

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "completed",
  "failed",
  "canceled",
]);

/** The terminal outcome a settled result may carry. */
export type SettledOutcome = "completed" | "failed";

/**
 * An immutable snapshot of a run's lifecycle position and watch generation.
 *
 * Instances are frozen. Transition methods never mutate the receiver; they
 * return a new {@link RunLifecycle} or throw.
 */
export class RunLifecycle {
  private constructor(
    /** The current lifecycle state. */
    public readonly state: RunState,
    /** The watch generation this run belongs to. */
    public readonly generation: Generation,
  ) {
    Object.freeze(this);
  }

  /**
   * Create a fresh run in the `queued` state.
   *
   * @param generation - The watch generation the run is created under.
   * @returns A queued {@link RunLifecycle}.
   */
  public static queued(generation: Generation): RunLifecycle {
    return new RunLifecycle("queued", generation);
  }

  /** Whether the run has reached a terminal state. */
  public get isTerminal(): boolean {
    return TERMINAL_RUN_STATES.has(this.state);
  }

  /**
   * Move to `target` if the transition is legal.
   *
   * @param target - The state to transition to.
   * @returns A new {@link RunLifecycle} in `target`.
   * @throws {IllegalRunTransitionError} If the transition is not permitted
   *   (including any attempt to leave a terminal state).
   */
  public to(target: RunState): RunLifecycle {
    if (!RUN_TRANSITIONS[this.state].includes(target)) {
      throw new IllegalRunTransitionError(this.state, target);
    }
    return new RunLifecycle(target, this.generation);
  }

  /** `queued -> starting`. */
  public start(): RunLifecycle {
    return this.to("starting");
  }

  /** `starting -> running`. */
  public run(): RunLifecycle {
    return this.to("running");
  }

  /** `running -> completed`. */
  public complete(): RunLifecycle {
    return this.to("completed");
  }

  /** Transition to `failed` from any state that permits it. */
  public fail(): RunLifecycle {
    return this.to("failed");
  }

  /**
   * Request cancellation.
   *
   * A cancellation request on a terminal run has no effect and returns the same
   * lifecycle unchanged. From `running` it enters `canceling`; from `starting`
   * it moves directly to `canceled`. From `queued` (no legal cancel edge) and
   * `canceling` (already in progress) it is a no-op, and the orchestrator
   * finalizes cancellation once the run advances.
   *
   * @returns The resulting lifecycle, possibly unchanged.
   */
  public requestCancel(): RunLifecycle {
    if (this.isTerminal) {
      return this;
    }
    switch (this.state) {
      case "running":
        return this.to("canceling");
      case "starting":
        return this.to("canceled");
      default:
        // queued or canceling: no immediate state change.
        return this;
    }
  }

  /** `canceling -> canceled`. */
  public confirmCanceled(): RunLifecycle {
    return this.to("canceled");
  }

  /**
   * Settle the run from an execution result, guarding against stale generations.
   *
   * A result produced by an older generation than the run's current generation
   * is rejected outright — it may neither transition nor commit the run.
   *
   * @param resultGeneration - The generation the result was produced in.
   * @param outcome - Whether the result completes or fails the run.
   * @returns A new terminal {@link RunLifecycle}.
   * @throws {StaleGenerationError} If `resultGeneration` is older than the run's.
   * @throws {IllegalRunTransitionError} If the outcome is illegal from the
   *   current state.
   */
  public settleFromResult(
    resultGeneration: Generation,
    outcome: SettledOutcome,
  ): RunLifecycle {
    if (
      resultGeneration !== this.generation &&
      isNewerGeneration(this.generation, resultGeneration)
    ) {
      throw new StaleGenerationError(resultGeneration, this.generation);
    }
    return this.to(outcome);
  }
}

/**
 * A read-only query for listing persisted runs. Absent fields impose no filter.
 */
export interface RunQuery {
  /** Restrict to a single problem slug. */
  readonly slug?: string;
  /** Lower bound (inclusive) on the run's wall time, as ISO-8601 text. */
  readonly since?: string;
  /** Restrict to a single normalized status. */
  readonly status?: ExecutionStatus;
  /** Maximum number of records to return. */
  readonly limit?: number;
}

/**
 * A durable snapshot of one completed run (a Memento).
 *
 * It captures everything required to report and replay the run deterministically:
 * the seed, limits, codec/comparator versions, content hashes, generation, and
 * timing. All fields are immutable.
 */
export interface PersistableRun {
  /** Identity of the run. */
  readonly runId: RunId;
  /** Problem slug the run targeted. */
  readonly slug: string;
  /** The terminal lifecycle state. */
  readonly state: TerminalRunState;
  /** The normalized execution status (verdict). */
  readonly status: ExecutionStatus;
  /** Stable fingerprint of the problem/config the run was computed against. */
  readonly problemFingerprint: string;
  /** Seed used for generation/replay, or `null` for fixed-case runs. */
  readonly seed: string | null;
  /** Resource limits the run executed under. */
  readonly limits: ResourceLimits;
  /** Version of the input codec used. */
  readonly inputCodecVersion: string;
  /** Version of the output codec used. */
  readonly outputCodecVersion: string;
  /** Version of the comparison policy applied. */
  readonly comparisonPolicyVersion: string;
  /** Content hash of the encoded input. */
  readonly inputHash: string;
  /** Content hash of the encoded output, or `null` when none was produced. */
  readonly outputHash: string | null;
  /** Watch generation the run belonged to. */
  readonly generation: Generation;
  /** Wall-clock start time as ISO-8601 UTC text. */
  readonly wallTimeUtc: string;
  /** Measured run duration in milliseconds. */
  readonly durationMs: number;
}
