/**
 * Public surface of the Linux full-enforcement sandbox adapter.
 *
 * The composition root (task 11) imports {@link createLinuxSandbox} and
 * {@link createLinuxSandboxConfig} to register the Linux backend's sandbox
 * component, and the `test` command (task 12) imports
 * {@link classifyTermination} to normalize a raw result into a stable execution
 * status. Internal machinery (controls, spawning, monitoring, reaping) is not
 * re-exported: callers depend on the {@link Sandbox} port surface plus the
 * config builder and classifier.
 */

// Sandbox factory (implements the Sandbox port).
export { createLinuxSandbox } from "./sandbox.js";

// Configuration.
export {
  createLinuxSandboxConfig,
  DEFAULT_REQUIRED_CONTROLS,
  DEFAULT_SIGTERM_GRACE_MS,
} from "./config.js";
export type {
  LinuxSandboxConfig,
  LinuxSandboxConfigSpec,
  RequiredControls,
} from "./config.js";

// Pure termination-cause classifier (consumed by the test command).
export { classifyTermination } from "./classify.js";

// Enforcement-mode detection.
export { probeEnforcement } from "./probe.js";
export type { EnforcementDecision, EnforcementMode } from "./probe.js";

// Control identity type (for configuring required controls).
export type { ControlId } from "./controls/control.js";

// Error types.
export {
  ControlUnavailableError,
  SandboxError,
  SandboxSetupError,
} from "./errors.js";
