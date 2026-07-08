/**
 * Argument-vector invocation value type.
 *
 * An {@link ArgvInvocation} names exactly what to execute and with which
 * arguments. It is deliberately an executable plus an argv array and NEVER a
 * shell string: the target is spawned directly, so there is no shell to perform
 * word-splitting, globbing, or command substitution, which removes an entire
 * class of command-injection risks.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/**
 * A direct (non-shell) process invocation.
 *
 * `executable` is resolved and launched as-is; `args` are passed verbatim as
 * separate argv entries. No element is ever concatenated into a shell command
 * line.
 */
export interface ArgvInvocation {
  /** The executable to launch (a resolved program, not a shell command line). */
  readonly executable: string;
  /** The argument vector, each element passed verbatim as a distinct argv slot. */
  readonly args: readonly string[];
}
