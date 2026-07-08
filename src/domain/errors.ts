/**
 * Domain error hierarchy.
 *
 * These errors express violations of domain invariants — illegal state
 * transitions and stale-generation commits. They subclass the ECMAScript
 * built-in {@link Error} only; the domain layer imports no Node, adapter, or
 * third-party module, so these remain runtime-neutral.
 */

/** Base class for every error raised by the pure domain layer. */
export class DomainError extends Error {
  public constructor(message: string) {
    super(message);
    // Restore the prototype chain across the Error super() call so that
    // `instanceof` works when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Raised when a run lifecycle is asked to move between two states that the run
 * state machine does not permit (for example `queued -> completed`).
 */
export class IllegalRunTransitionError extends DomainError {
  /**
   * @param from - The state the run was in.
   * @param to - The state the caller attempted to move to.
   */
  public constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`illegal run transition: ${from} -> ${to}`);
  }
}

/**
 * Raised when a watch lifecycle is asked to move between two states that the
 * watch state machine does not permit (for example `stopped -> observing`).
 */
export class IllegalWatchTransitionError extends DomainError {
  /**
   * @param from - The state the watcher was in.
   * @param to - The state the caller attempted to move to.
   */
  public constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`illegal watch transition: ${from} -> ${to}`);
  }
}

/**
 * Raised when a result produced by an older watch generation attempts to
 * transition or commit a run that has already advanced to a newer generation.
 */
export class StaleGenerationError extends DomainError {
  /**
   * @param resultGeneration - The generation the stale result was produced in.
   * @param currentGeneration - The generation the run has since advanced to.
   */
  public constructor(
    public readonly resultGeneration: number,
    public readonly currentGeneration: number,
  ) {
    super(
      `stale generation: result from generation ${resultGeneration} ` +
        `cannot commit run at generation ${currentGeneration}`,
    );
  }
}
