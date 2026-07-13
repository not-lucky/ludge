/**
 * Direct child spawning for the Linux sandbox.
 *
 * {@link spawnChild} launches the target as a real child process — never a shell
 * — composing any control wrapper prefix (`unshare`, `prlimit`, `setpriv`) in
 * front of the invocation. The child starts detached so it becomes the leader of
 * a new session and process group: signalling the negative PID later reaches the
 * whole group, which is how forked grandchildren are contained and killed. Only
 * the sanitized environment is passed, stdin is closed, and stdout/stderr are the
 * sole inherited descriptors (as pipes), so no ambient file descriptor leaks into
 * the target.
 *
 * This is an adapter module and may use Node builtins.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { ArgvInvocation } from "../../ports/index.js";
import type { LinuxSandboxConfig } from "./config.js";

/**
 * Compose the wrapper prefix and the invocation into an executable + argv.
 *
 * When a prefix is present its first element is the executable and the rest —
 * followed by the real invocation — become the arguments; each control has
 * already appended its own `--` option terminator.
 */
function composeArgv(
  invocation: ArgvInvocation,
  argvPrefix: readonly string[],
): { executable: string; args: string[] } {
  if (argvPrefix.length === 0) {
    return { executable: invocation.executable, args: [...invocation.args] };
  }
  const [wrapper, ...wrapperArgs] = argvPrefix;
  return {
    executable: wrapper!,
    args: [...wrapperArgs, invocation.executable, ...invocation.args],
  };
}

/**
 * Spawn the (optionally wrapped) target as a detached child in its own session.
 *
 * The returned {@link ChildProcess} has `stdout`/`stderr` pipes for bounded
 * collection and a `null` `stdin`. The caller MUST attach `error`/`exit`
 * listeners synchronously (before awaiting) so a spawn failure is observed.
 *
 * @param invocation - The direct, non-shell target invocation.
 * @param config - The sandbox configuration (working directory + environment).
 * @param argvPrefix - The composed control wrapper prefix (possibly empty).
 * @returns The spawned child process.
 */
export function spawnChild(
  invocation: ArgvInvocation,
  config: LinuxSandboxConfig,
  argvPrefix: readonly string[],
): ChildProcess {
  const { executable, args } = composeArgv(invocation, argvPrefix);
  return spawn(executable, args, {
    cwd: config.workingDirectory,
    // The complete, allow-listed environment: nothing is inherited from the
    // supervisor process.
    env: { ...config.environment },
    // New session + process group so the negative-PID signal reaches every
    // descendant, and no controlling terminal is shared.
    detached: true,
    // The caller writes one bounded canonical request envelope and closes stdin.
    stdio: ["pipe", "pipe", "pipe"],
    // Never route through a shell — the invocation is a resolved argv.
    shell: false,
  });
}
