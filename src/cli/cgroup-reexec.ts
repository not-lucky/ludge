/**
 * Transparent cgroup re-exec for the Palestra CLI on Linux.
 *
 * On a systemd Linux host the Palestra process typically lives in its login
 * session's cgroup (e.g. `session-2.scope` under `user-1000.slice`), while
 * `PALESTRA_CGROUP_PARENT` points to a delegated subtree under the user's
 * systemd manager (e.g. `user@1000.service/palestra.slice/sandbox`).  These
 * two branches share a common ancestor (`user-1000.slice`) that is owned by
 * root, so the kernel rightfully denies an unprivileged PID migration from
 * one branch into the other.
 *
 * Rather than requiring the operator to wrap every invocation in
 * `systemd-run --user --scope --slice=palestra.slice --`, this module
 * detects the branch mismatch and transparently re-execs the current
 * process inside the correct slice.  The re-exec is a one-shot: the child
 * inherits the full argv and environment, and an internal sentinel variable
 * (`__PALESTRA_REEXEC`) prevents infinite recursion.
 *
 * This module is intentionally free of application-layer imports so it can
 * run very early in the bootstrap, before context construction or command
 * parsing.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Sentinel environment variable set during re-exec.  If present the current
 * process is already inside the target scope and must not re-exec again.
 */
const REEXEC_SENTINEL = "__PALESTRA_REEXEC";

/**
 * Try to re-exec the current process inside the cgroup subtree that
 * contains `PALESTRA_CGROUP_PARENT`.  Returns `undefined` when no re-exec
 * is needed (already in the right subtree, not Linux, `--unsafe-local`,
 * sentinel present, or detection fails gracefully).  Returns an exit code
 * when re-exec completed.
 *
 * The caller should treat a returned exit code as the final process result
 * and skip normal bootstrap.
 */
export function maybeCgroupReexec(argv: readonly string[]): number | undefined {
  // ── Guard: only applies on Linux with full sandbox enforcement. ──────
  if (process.platform !== "linux") return undefined;
  if (argv.includes("--unsafe-local")) return undefined;

  // Guard: commands that don't use the sandbox at all (init, report).
  // Only test, stress-test, watch, benchmark, and replay spawn targets.
  const commandName = argv.find(
    (arg) => !arg.startsWith("-") && !arg.startsWith("--"),
  );
  if (
    commandName === undefined ||
    !["test", "stress-test", "watch", "benchmark", "replay"].includes(
      commandName,
    )
  ) {
    return undefined;
  }

  // Guard: already re-execed — do not recurse.
  if (process.env[REEXEC_SENTINEL] === "1") return undefined;

  // ── Determine the target cgroup parent. ──────────────────────────────
  const cgroupParent = resolve(
    process.env.PALESTRA_CGROUP_PARENT ?? "/sys/fs/cgroup/palestra",
  );

  // The cgroup parent must live under /sys/fs/cgroup to be a real cgroup.
  const cgroupMount = "/sys/fs/cgroup";
  if (!cgroupParent.startsWith(cgroupMount + "/")) return undefined;

  // ── Read the current process's cgroup from procfs. ───────────────────
  // Format: a single line like `0::/user.slice/user-1000.slice/session-2.scope`
  let selfCgroupPath: string;
  try {
    const raw = readFileSync("/proc/self/cgroup", "utf8").trim();
    // cgroup v2 uses the unified hierarchy — the entry starts with `0::`.
    const line = raw.split("\n").find((l) => l.startsWith("0::"));
    if (line === undefined) return undefined;
    selfCgroupPath = line.slice("0::".length); // e.g. /user.slice/.../session-2.scope
  } catch {
    // If /proc/self/cgroup is unreadable, silently skip re-exec.  The
    // sandbox setup will fail with a clear error later.
    return undefined;
  }

  // ── Check whether the current process is already under the same
  //    user-owned subtree that contains the cgroup parent. ──────────────
  //
  // The goal: both the process cgroup and the target parent must share a
  // common ancestor that the user owns and can migrate PIDs across.  In
  // practice this means they must both be under the same `user@UID.service`
  // subtree (the systemd user manager), or the process must already be
  // inside the slice that hosts the sandbox.
  //
  // We extract the subtree prefix up to and including the first `.slice`
  // component that is a child of the user manager (e.g.
  // `/user.slice/user-1000.slice/user@1000.service/palestra.slice`).
  // If both paths share that prefix, the process is already in the right
  // branch and no re-exec is needed.
  const cgroupRelative = cgroupParent.slice(cgroupMount.length); // e.g. /user.slice/.../sandbox
  const targetSlice = extractUserSlice(cgroupRelative);
  if (targetSlice === undefined) {
    // The cgroup parent isn't under a user service slice — it might be a
    // root-delegated cgroup.  Re-exec can't help here.
    return undefined;
  }

  if (selfCgroupPath.startsWith(targetSlice + "/")) {
    // Already in the correct subtree.  No re-exec needed.
    return undefined;
  }

  // ── Re-exec under `systemd-run --user --scope --slice=<slice>`. ──────
  //
  // Extract just the slice unit name from the path for systemd-run.
  // E.g. from `/user.slice/user-1000.slice/user@1000.service/palestra.slice`
  // we want `palestra.slice`.
  const sliceUnit = targetSlice.split("/").pop()!;
  const reexecEnv = { ...process.env, [REEXEC_SENTINEL]: "1" };

  try {
    const result = execFileSync(
      "systemd-run",
      [
        "--user",
        "--scope",
        `--slice=${sliceUnit}`,
        "--quiet",
        "--",
        process.execPath, // node
        ...process.argv.slice(1), // CLI script + user args
      ],
      {
        cwd: process.cwd(),
        env: reexecEnv,
        stdio: "inherit",
        // execFileSync throws on nonzero — we handle the exit code from
        // the thrown error below.
      } satisfies ExecFileSyncOptions,
    );
    // If we reach here, the child exited 0.
    void result;
    return 0;
  } catch (error: unknown) {
    // execFileSync throws on nonzero exit.  Extract the child's exit code
    // and propagate it as-is so the caller sees the real palestra result.
    if (isExecSyncError(error)) {
      return error.status ?? 1;
    }
    // systemd-run itself may be missing or the D-Bus session unavailable.
    // Fall through to normal bootstrap so the sandbox setup produces its
    // own clear diagnostic.
    return undefined;
  }
}

/**
 * Extract the user-service slice prefix from a cgroup path.
 *
 * Given `/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox`,
 * returns `/user.slice/user-1000.slice/user@1000.service/palestra.slice`.
 *
 * The heuristic looks for a `user@<N>.service` component and then the first
 * `.slice` that follows it — that's the delegated slice Palestra should
 * target.  Returns `undefined` if the pattern isn't found.
 */
function extractUserSlice(cgroupPath: string): string | undefined {
  const parts = cgroupPath.split("/").filter(Boolean);
  let userServiceIndex = -1;

  // Find the `user@<N>.service` component.
  for (let i = 0; i < parts.length; i++) {
    if (/^user@\d+\.service$/.test(parts[i]!)) {
      userServiceIndex = i;
      break;
    }
  }
  if (userServiceIndex === -1) return undefined;

  // Find the first `.slice` component after the user service.
  for (let i = userServiceIndex + 1; i < parts.length; i++) {
    if (parts[i]!.endsWith(".slice")) {
      return "/" + parts.slice(0, i + 1).join("/");
    }
  }

  // If there's no slice after the user service, the user service itself
  // is the common subtree.
  return "/" + parts.slice(0, userServiceIndex + 1).join("/");
}

/** Type guard for the error shape thrown by `execFileSync`. */
function isExecSyncError(
  error: unknown,
): error is Error & { status: number | null } {
  return error instanceof Error && "status" in error;
}
