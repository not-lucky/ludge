/**
 * Process-tree termination and reaping (Composite cleanup path).
 *
 * Every way a run can end — a wall/CPU deadline, cancellation, output overflow,
 * an ignored `SIGTERM`, forked grandchildren, or a spawn/setup failure — funnels
 * through the same escalation here: signal the whole process *group* with
 * `SIGTERM`, wait the configured grace, then escalate to `SIGKILL` on the group
 * and, atomically, on any remaining cgroup descendants via `cgroup.kill`. Because
 * the child was spawned in its own session/process group, the negative-PID signal
 * reaches descendants a lone-PID signal would miss.
 *
 * Termination is best-effort and never throws: an already-dead group (`ESRCH`)
 * is a benign no-op, and any real signalling problem is recorded as a cleanup
 * diagnostic so the run still produces a bounded result and leaves no orphan.
 *
 * This is an adapter module and may use Node builtins.
 */

import type { ChildProcess } from "node:child_process";

import type { Cgroupv2Control } from "./controls/cgroup.js";

/** A promise that resolves after `ms` milliseconds without pinning the loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Send a signal to an entire process group, tolerating an already-dead group.
 *
 * @param pid - The group leader pid (the detached child's pid == its pgid).
 * @param signal - The signal to deliver to the group.
 * @returns Cleanup diagnostics (empty on success or a benign `ESRCH`).
 */
function signalGroup(pid: number, signal: NodeJS.Signals): readonly string[] {
  try {
    // A negative pid targets the whole process group.
    process.kill(-pid, signal);
    return [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // The group already exited — nothing to clean up.
      return [];
    }
    return [`failed to send ${signal} to process group ${pid}: ${code ?? String(error)}`];
  }
}

/**
 * Terminate a run's entire process tree with graceful escalation.
 *
 * @param child - The spawned group-leader child.
 * @param cgroup - The run's cgroup control, used for the atomic descendant kill.
 * @param sigtermGraceMs - Milliseconds to wait after `SIGTERM` before `SIGKILL`.
 * @returns Aggregated cleanup diagnostics (empty when nothing went wrong).
 */
export async function terminateProcessTree(
  child: ChildProcess,
  cgroup: Cgroupv2Control,
  sigtermGraceMs: number,
): Promise<readonly string[]> {
  const pid = child.pid;
  if (pid === undefined) {
    // Never spawned; the cgroup (if any) is emptied for good measure.
    await cgroup.killAll();
    return [];
  }

  const diagnostics: string[] = [];
  diagnostics.push(...signalGroup(pid, "SIGTERM"));

  // Give the group a chance to exit cleanly, then escalate unconditionally.
  await delay(sigtermGraceMs);

  diagnostics.push(...signalGroup(pid, "SIGKILL"));
  // The cgroup kill switch reaps descendants that escaped the group signal
  // (e.g. a grandchild that changed its own process group).
  await cgroup.killAll();

  return diagnostics;
}
