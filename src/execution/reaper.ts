import type { ChildProcess } from "node:child_process";
import type { RunCgroup } from "./cgroup.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function signal(pid: number, value: NodeJS.Signals): string | null {
  try {
    process.kill(-pid, value);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? null
      : `failed to send ${value}: ${String(error)}`;
  }
}

/** Best-effort graceful process-group and cgroup termination. */
export async function terminateProcessTree(
  child: ChildProcess,
  cgroup: RunCgroup,
  graceMs: number,
): Promise<readonly string[]> {
  const diagnostics: string[] = [];
  if (child.pid !== undefined) {
    const result = signal(child.pid, "SIGTERM");
    if (result) diagnostics.push(result);
    await delay(graceMs);
    const kill = signal(child.pid, "SIGKILL");
    if (kill) diagnostics.push(kill);
  }
  await cgroup.killAll();
  return diagnostics;
}
