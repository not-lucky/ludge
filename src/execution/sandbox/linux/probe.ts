/**
 * Enforcement-mode detection and the fail-closed gate.
 *
 * Before any child is spawned, the sandbox decides whether the host can be
 * trusted to enforce the boundary. {@link probeEnforcement} inspects the
 * platform and probes every control, producing an {@link EnforcementDecision}:
 *
 * - `full` — Linux and every required control is available; a normal verdict is
 *   trustworthy.
 * - `degraded` — Linux and every *required* control is available, but one or
 *   more *optional* controls are missing. Still trustworthy, with less
 *   defense in depth.
 * - `unsupported` — not Linux, or a required control is unavailable. The run
 *   MUST fail closed: it is never spawned as a normally-classifiable child, so a
 *   `passed` verdict is impossible when a required boundary is absent.
 *
 * This module contains the single decision that upholds the spec's central
 * safety rule ("a normal pass is forbidden if a required control was absent").
 *
 * This is an adapter module and may use Node builtins.
 */

import type { CompositeControls, ControlId } from "./controls/control.js";

/** The three trust levels a host can offer for a run. */
export type EnforcementMode = "full" | "degraded" | "unsupported";

/** The outcome of probing the host's enforcement capability. */
export interface EnforcementDecision {
  /** The detected enforcement mode. */
  readonly mode: EnforcementMode;
  /** When not `full`, human-readable reasons (missing controls / platform). */
  readonly reasons: readonly string[];
  /** Ids of required controls that were unavailable (drives fail-closed). */
  readonly missingRequired: readonly ControlId[];
}

/**
 * Probe the host and decide the enforcement mode for a run.
 *
 * @param controls - The composite of every control the sandbox would install.
 * @param optionalMissing - Optional controls already known to be unavailable,
 *   supplied by the caller to distinguish `full` from `degraded`. When omitted
 *   the decision only reflects platform + required-control availability.
 * @returns The enforcement decision.
 */
export async function probeEnforcement(
  controls: CompositeControls,
  optionalMissing: readonly string[] = [],
): Promise<EnforcementDecision> {
  if (process.platform !== "linux") {
    return {
      mode: "unsupported",
      reasons: [
        `full enforcement requires Linux, running on ${process.platform}`,
      ],
      missingRequired: [],
    };
  }

  const missing = await controls.missingRequired();
  if (missing.length > 0) {
    return {
      mode: "unsupported",
      reasons: missing.map((m) => `required control '${m.id}': ${m.reason}`),
      missingRequired: missing.map((m) => m.id),
    };
  }

  if (optionalMissing.length > 0) {
    return {
      mode: "degraded",
      reasons: [...optionalMissing],
      missingRequired: [],
    };
  }

  return { mode: "full", reasons: [], missingRequired: [] };
}
