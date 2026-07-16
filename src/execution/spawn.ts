import { spawn, type ChildProcess } from "node:child_process";
import type { ArgvInvocation } from "./runner.js";

export interface SpawnPolicy {
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** Spawn a direct argv (optionally under fixed `prlimit`) in a new process group. */
export function spawnChild(
  invocation: ArgvInvocation,
  policy: SpawnPolicy,
  prefix: readonly string[] = [],
): ChildProcess {
  const [executable, ...prefixArgs] = prefix;
  return spawn(
    executable ?? invocation.executable,
    executable === undefined
      ? [...invocation.args]
      : [...prefixArgs, invocation.executable, ...invocation.args],
    {
      cwd: policy.workingDirectory,
      env: { ...policy.environment },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
}
