/**
 * `--unsafe-local` policy.
 *
 * The sandbox contract is emphatic that unsafe-local mode is *explicit only*:
 * it is never implied by platform detection, it labels every affected result
 * `sandbox_unsupported`, and it can never produce a normal pass. This module
 * encodes those two rules — how the flag is resolved and the stable label it
 * forces — so no command layer can accidentally weaken them.
 *
 * The status label reuses the domain's `sandbox_unsupported` literal; this
 * module imports the type only and holds no host state.
 */

import type { ExecutionStatus } from "../../domain/index.js";

/**
 * The stable execution status forced onto every result produced while
 * `--unsafe-local` is active. Because it sits in the highest precedence tier, it
 * dominates any would-be `passed` outcome, so an unsafe run can never be
 * reported as a normal pass.
 */
export const SANDBOX_UNSUPPORTED_LABEL: ExecutionStatus = "sandbox_unsupported";

/**
 * Resolve whether unsafe-local mode is active.
 *
 * This is intentionally a pure pass-through of the explicit CLI flag: there is
 * no platform sniffing and no environment fallback, so the mode can only be
 * enabled by the user asking for it directly.
 *
 * @param explicitFlag - Whether `--unsafe-local` was passed on the command line.
 * @returns `true` iff the user explicitly requested unsafe-local mode.
 */
export function resolveUnsafeLocal(explicitFlag: boolean): boolean {
  return explicitFlag === true;
}

/**
 * Apply the unsafe-local labeling rule to a would-be execution status.
 *
 * When unsafe-local mode is active, the observed status is overridden with
 * {@link SANDBOX_UNSUPPORTED_LABEL} so the missing enforcement boundary is
 * always visible and a pass is impossible. When it is inactive, the status is
 * returned unchanged.
 *
 * @param unsafeLocal - Whether unsafe-local mode is active.
 * @param observed - The status the execution would otherwise carry.
 * @returns The label-adjusted status.
 */
export function labelForUnsafeLocal(
  unsafeLocal: boolean,
  observed: ExecutionStatus,
): ExecutionStatus {
  return unsafeLocal ? SANDBOX_UNSUPPORTED_LABEL : observed;
}
