/**
 * Stable control identifiers for the Linux sandbox.
 *
 * This is a dependency-free leaf module: it declares only the {@link ControlId}
 * union. Both the control abstraction and the config/error modules reference
 * control ids, so hosting the type here keeps those modules from importing each
 * other in a cycle (config ↔ control, errors ↔ control).
 */

/** Stable identifier of a single sandbox control. */
export type ControlId =
  | "cgroup"
  | "rlimits"
  | "network"
  | "filesystem"
  | "no-new-privileges"
  | "drop-capabilities"
  | "namespaces"
  | "seccomp";
