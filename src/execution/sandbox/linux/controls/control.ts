/**
 * Sandbox control abstraction (Strategy + Composite).
 *
 * A "control" is one defense-in-depth mechanism the Linux sandbox installs
 * around a child: the cgroup boundary, rlimits, network denial, the restricted
 * filesystem view, no-new-privileges, dropped capabilities, namespaces, and
 * (optional) seccomp. Each control is a {@link SandboxControl} Strategy that can
 * independently report whether it is available on the host ({@link SandboxControl.probe})
 * and, if so, install itself and yield an {@link InstalledControl} that both
 * contributes to the child's launch prefix and knows how to tear itself down.
 *
 * {@link CompositeControls} treats the whole set as one control (Composite): it
 * probes/installs the members in order, rolls back on any required-control
 * failure, and provides a single idempotent teardown that runs members in
 * reverse and never throws. Modeling controls this way keeps each mechanism
 * small and testable, and lets the fail-closed policy live in one place.
 *
 * This module declares the seam and its composite; concrete controls live in
 * sibling files. It imports only sibling types and domain values.
 */

import type { ResourceLimits } from "../../../../domain/index.js";
import type { LinuxSandboxConfig } from "../config.js";
import { ControlUnavailableError } from "../errors.js";
import type { ControlId } from "./ids.js";

export type { ControlId } from "./ids.js";

/** The outcome of probing a control's availability on the current host. */
export interface ControlProbe {
  /** Whether the control can be installed on this host. */
  readonly available: boolean;
  /** When unavailable, a human-readable explanation. */
  readonly reason?: string;
}

/** Everything a control needs at install time. */
export interface ControlContext {
  /** The resource ceilings the run must enforce (rlimits derive from these). */
  readonly limits: ResourceLimits;
  /** Absolute path to this run's temporary root directory. */
  readonly tempRoot: string;
  /** The frozen sandbox configuration (cwd, environment, read-only paths, …). */
  readonly config: LinuxSandboxConfig;
}

/**
 * A control that has been installed for one run.
 *
 * `argvPrefix` is prepended to the target invocation so wrapper tools (for
 * example `unshare` or `prlimit`) apply before the child image is executed;
 * controls that need no wrapper contribute an empty prefix. `teardown` reverses
 * the installation and MUST be safe to call more than once.
 */
export interface InstalledControl {
  /** Wrapper argv prepended to the invocation, or empty if none is needed. */
  readonly argvPrefix: readonly string[];
  /**
   * Reverse this control's installation. Idempotent and best-effort: it records
   * problems rather than throwing so cleanup of the whole set can continue.
   *
   * @returns Zero or more human-readable cleanup diagnostics.
   */
  teardown(): Promise<readonly string[]>;
}

/**
 * One defense-in-depth mechanism the sandbox can install around a child.
 *
 * @remarks A control marked `required` that is unavailable causes the run to
 * fail closed; an optional control that is unavailable is simply skipped.
 */
export interface SandboxControl {
  /** This control's stable identity. */
  readonly id: ControlId;
  /** Whether the run must fail closed when this control cannot be installed. */
  readonly required: boolean;
  /**
   * Report whether this control can be installed on the current host.
   *
   * @returns The probe outcome.
   */
  probe(): Promise<ControlProbe>;
  /**
   * Install the control for one run.
   *
   * @param context - The per-run install context.
   * @returns The installed control handle.
   */
  install(context: ControlContext): Promise<InstalledControl>;
}

/** The combined result of installing a set of controls. */
export interface CompositeInstallResult {
  /** The concatenated wrapper argv from every installed control, in order. */
  readonly argvPrefix: readonly string[];
  /**
   * Tear down every installed control in reverse order.
   *
   * @returns The aggregated cleanup diagnostics from all members.
   */
  teardown(): Promise<readonly string[]>;
}

/** A control paired with its installed handle, for ordered teardown. */
interface InstalledEntry {
  readonly id: ControlId;
  readonly handle: InstalledControl;
}

/**
 * Tear down installed controls in reverse order, aggregating diagnostics and
 * never throwing, so a single failing teardown cannot abort the rest.
 */
async function teardownAll(
  installed: readonly InstalledEntry[],
): Promise<readonly string[]> {
  const diagnostics: string[] = [];
  for (let i = installed.length - 1; i >= 0; i -= 1) {
    const entry = installed[i]!;
    try {
      diagnostics.push(...(await entry.handle.teardown()));
    } catch (error) {
      diagnostics.push(
        `control '${entry.id}' teardown failed: ${describeError(error)}`,
      );
    }
  }
  return diagnostics;
}

/** Render an unknown thrown value as a short diagnostic string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Treats a set of {@link SandboxControl}s as one composite control.
 *
 * The members are probed and installed in the order supplied; the argv prefixes
 * compose left-to-right so the first member is the outermost wrapper.
 */
export class CompositeControls {
  /**
   * @param controls - The ordered set of controls to manage as one.
   */
  public constructor(private readonly controls: readonly SandboxControl[]) {}

  /**
   * Probe every control and return the required ones that are unavailable.
   *
   * Used by enforcement-mode detection to decide, before any child is spawned,
   * whether the run can be trusted or must fail closed.
   *
   * @returns The id/reason of each unavailable required control (empty when all
   *   required controls are present).
   */
  public async missingRequired(): Promise<
    readonly { readonly id: ControlId; readonly reason: string }[]
  > {
    const missing: { id: ControlId; reason: string }[] = [];
    for (const control of this.controls) {
      if (!control.required) {
        continue;
      }
      const probe = await control.probe();
      if (!probe.available) {
        missing.push({
          id: control.id,
          reason: probe.reason ?? "unavailable",
        });
      }
    }
    return missing;
  }

  /**
   * Probe every *optional* control and return a reason for each that is
   * unavailable. Used to distinguish `full` from `degraded` enforcement without
   * affecting the fail-closed decision (which only concerns required controls).
   *
   * @returns Human-readable reasons for each unavailable optional control.
   */
  public async optionalUnavailable(): Promise<readonly string[]> {
    const reasons: string[] = [];
    for (const control of this.controls) {
      if (control.required) {
        continue;
      }
      const probe = await control.probe();
      if (!probe.available) {
        reasons.push(
          `optional control '${control.id}': ${probe.reason ?? "unavailable"}`,
        );
      }
    }
    return reasons;
  }

  /**
   * Install every available control, rolling back on a required-control failure.
   *
   * Available controls are installed in order; unavailable optional controls are
   * skipped; an unavailable or failing required control triggers rollback of the
   * controls already installed and rethrows so the run fails closed.
   *
   * @param context - The per-run install context.
   * @returns The composite argv prefix and a single reverse-order teardown.
   * @throws {ControlUnavailableError} If a required control is unavailable.
   */
  public async install(
    context: ControlContext,
  ): Promise<CompositeInstallResult> {
    const installed: InstalledEntry[] = [];
    const argvPrefix: string[] = [];
    try {
      for (const control of this.controls) {
        const probe = await control.probe();
        if (!probe.available) {
          if (control.required) {
            throw new ControlUnavailableError(
              control.id,
              probe.reason ?? "unavailable",
            );
          }
          continue;
        }
        const handle = await control.install(context);
        installed.push({ id: control.id, handle });
        argvPrefix.push(...handle.argvPrefix);
      }
    } catch (error) {
      // Best-effort rollback of whatever was installed before the failure so a
      // partial setup never leaks controls; then rethrow to fail closed.
      await teardownAll(installed);
      throw error;
    }

    return {
      argvPrefix,
      teardown: () => teardownAll(installed),
    };
  }
}
