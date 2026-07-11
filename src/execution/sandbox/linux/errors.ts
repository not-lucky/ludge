/**
 * Linux sandbox error types.
 *
 * These are raised inside the sandbox setup/cleanup machinery when a control
 * cannot be honored. They never escape the {@link Sandbox.run} boundary: `run`
 * catches them and folds them into a fail-closed {@link RawProcessResult}
 * (`termination: "spawn_failed"`) so a missing boundary can never be mistaken
 * for a normal pass. They exist so the internal control chain can signal *why*
 * setup failed and surface a precise diagnostic.
 *
 * The shape mirrors the codec/comparator error classes in the judging layer
 * (restore the prototype chain and set `name`).
 */

import type { ControlId } from "./controls/ids.js";

/** Base class for every error raised inside the Linux sandbox adapter. */
export class SandboxError extends Error {
  public constructor(message: string) {
    super(message);
    // Restore the prototype chain across the Error super() call so that
    // `instanceof` works when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Raised when a required control cannot be probed or installed during setup.
 *
 * Carries the offending control id and a human-readable reason so the sandbox
 * can record a precise cleanup diagnostic before failing closed.
 */
export class SandboxSetupError extends SandboxError {
  /**
   * @param controlId - The control whose setup failed.
   * @param reason - A human-readable explanation of the failure.
   */
  public constructor(
    public readonly controlId: ControlId,
    public readonly reason: string,
  ) {
    super(`sandbox control '${controlId}' failed setup: ${reason}`);
  }
}

/**
 * Raised when a required control is unavailable on this host (for example the
 * unified cgroup v2 hierarchy is not mounted, or the process runs on a
 * non-Linux platform).
 *
 * Distinct from {@link SandboxSetupError} in that the control was never even
 * present to attempt: this drives the `unsupported` enforcement mode.
 */
export class ControlUnavailableError extends SandboxError {
  /**
   * @param controlId - The control that is unavailable.
   * @param reason - Why the control is unavailable on this host.
   */
  public constructor(
    public readonly controlId: ControlId,
    public readonly reason: string,
  ) {
    super(`sandbox control '${controlId}' is unavailable: ${reason}`);
  }
}
