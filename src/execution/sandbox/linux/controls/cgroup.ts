/**
 * Cgroup v2 control — the authoritative memory / pid / kill boundary.
 *
 * On Linux this control owns the run's resource truth: it creates a fresh child
 * cgroup under the supervisor-owned parent, writes the memory and pid ceilings,
 * registers the child process into the cgroup before supervision begins, samples
 * the memory peak and OOM counters during the run, and can kill the entire
 * descendant tree atomically via `cgroup.kill`. The wall-clock deadline and this
 * cgroup are the sole authoritative TLE/MLE mechanisms — rlimits are only
 * defense in depth.
 *
 * Enforcement is performed through the cgroup v2 filesystem (writing the control
 * files under a delegated subtree), so it needs a writable unified hierarchy but
 * no native addon. When the hierarchy is absent or not writable, the control
 * probes as unavailable and — being required by default — makes the run fail
 * closed.
 *
 * This is an adapter module and may use Node builtins.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import type {
  ControlContext,
  ControlProbe,
  InstalledControl,
  SandboxControl,
} from "./control.js";

/** Parsed subset of a cgroup's `memory.events` file. */
export interface CgroupMemoryEvents {
  /** Number of times the cgroup's memory high boundary was breached. */
  readonly oom: number;
  /** Number of processes the kernel OOM-killed inside the cgroup. */
  readonly oomKill: number;
}

/**
 * The cgroup v2 control plus the extra run-time operations the sandbox lifecycle
 * needs (PID registration, sampling, and tree kill), which fall outside the
 * generic {@link SandboxControl} surface.
 */
export interface Cgroupv2Control extends SandboxControl {
  /**
   * Move a freshly spawned process into this run's cgroup.
   *
   * A child that has already exited yields a benign no-op (its slot is gone);
   * the caller still reaps and classifies it.
   *
   * @param pid - The child process id to register.
   */
  registerPid(pid: number): Promise<void>;
  /**
   * Sample the peak memory the cgroup has used, in bytes.
   *
   * Prefers `memory.peak`; falls back to `memory.current` on older kernels.
   * Best-effort: returns `0` if the value cannot be read.
   */
  sampleMemoryPeakBytes(): Promise<number>;
  /**
   * Read the cgroup's OOM event counters. Best-effort: zeros if unreadable.
   */
  readMemoryEvents(): Promise<CgroupMemoryEvents>;
  /**
   * Read cumulative CPU time consumed by the cgroup, in milliseconds.
   * Best-effort: returns `0` if `cpu.stat` cannot be read.
   */
  readCpuUsageMs(): Promise<number>;
  /**
   * Count the live processes currently in the cgroup. Best-effort: `0` on error.
   */
  countProcesses(): Promise<number>;
  /**
   * Kill every process in the cgroup atomically via `cgroup.kill`.
   *
   * @returns `true` if the kill switch was written, `false` if unavailable (the
   *   caller then falls back to process-group signalling).
   */
  killAll(): Promise<boolean>;
}

/** Write a single control value, appending a newline as the kernel expects. */
async function writeControl(path: string, value: string): Promise<void> {
  await writeFile(path, `${value}\n`);
}

/** Read a control file, returning `null` when it is absent or unreadable. */
async function readControl(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Parse an integer from control text, yielding `0` for missing/`max` values. */
function parseCount(text: string | null): number {
  if (text === null) {
    return 0;
  }
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "max") {
    return 0;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Create the cgroup v2 control bound to a configured parent cgroup.
 *
 * @param cgroupParentPath - Absolute path to the supervisor-owned parent cgroup.
 * @param required - Whether the run must fail closed if the control is missing.
 * @returns A {@link Cgroupv2Control}.
 */
export function createCgroupv2Control(
  cgroupParentPath: string,
  required = true,
): Cgroupv2Control {
  // Set once at install; the extra operations key off it. `null` means the
  // cgroup has not been created (or has been torn down) yet.
  let childPath: string | null = null;

  const controlFile = (name: string): string => {
    if (childPath === null) {
      throw new Error("cgroup not installed");
    }
    return join(childPath, name);
  };

  return {
    id: "cgroup",
    required,

    async probe(): Promise<ControlProbe> {
      if (process.platform !== "linux") {
        return {
          available: false,
          reason: `cgroup v2 requires Linux, running on ${process.platform}`,
        };
      }
      try {
        // The unified hierarchy exposes `cgroup.controllers`; the parent must be
        // writable so we can create and configure a child cgroup beneath it.
        await access(
          join(cgroupParentPath, "cgroup.controllers"),
          fsConstants.R_OK,
        );
        await access(cgroupParentPath, fsConstants.W_OK | fsConstants.X_OK);
        return { available: true };
      } catch (error) {
        return {
          available: false,
          reason: `cgroup v2 parent '${cgroupParentPath}' not usable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },

    async install(context: ControlContext): Promise<InstalledControl> {
      const path = join(cgroupParentPath, `run-${randomUUID()}`);
      await mkdir(path, { recursive: false });
      childPath = path;

      // Best-effort: ask the parent to delegate the memory and pids controllers
      // to children. Harmless if already enabled or not permitted.
      await writeControl(
        join(cgroupParentPath, "cgroup.subtree_control"),
        "+memory +pids",
      ).catch(() => undefined);

      // Authoritative ceilings. Swap is pinned to zero so memory pressure cannot
      // be masked by swapping, keeping `mle` detection honest.
      await writeControl(join(path, "memory.max"), String(context.limits.memoryBytes));
      await writeControl(join(path, "memory.swap.max"), "0").catch(() => undefined);
      await writeControl(join(path, "pids.max"), String(context.limits.processCount));

      return {
        argvPrefix: [],
        async teardown(): Promise<readonly string[]> {
          const target = childPath;
          if (target === null) {
            return [];
          }
          childPath = null;
          try {
            await rm(target, { recursive: true, force: true });
            return [];
          } catch (error) {
            return [
              `cgroup removal failed for '${target}': ${
                error instanceof Error ? error.message : String(error)
              }`,
            ];
          }
        },
      };
    },

    async registerPid(pid: number): Promise<void> {
      try {
        await writeControl(controlFile("cgroup.procs"), String(pid));
      } catch (error) {
        // ESRCH: the child exited during registration — benign, it is reaped by
        // the caller. Anything else is surfaced so setup can fail closed.
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          return;
        }
        throw error;
      }
    },

    async sampleMemoryPeakBytes(): Promise<number> {
      if (childPath === null) {
        return 0;
      }
      const peak = parseCount(await readControl(controlFile("memory.peak")));
      if (peak > 0) {
        return peak;
      }
      return parseCount(await readControl(controlFile("memory.current")));
    },

    async readMemoryEvents(): Promise<CgroupMemoryEvents> {
      if (childPath === null) {
        return { oom: 0, oomKill: 0 };
      }
      const text = await readControl(controlFile("memory.events"));
      if (text === null) {
        return { oom: 0, oomKill: 0 };
      }
      let oom = 0;
      let oomKill = 0;
      for (const line of text.split("\n")) {
        const [key, value] = line.trim().split(/\s+/);
        if (key === "oom") {
          oom = parseCount(value ?? null);
        } else if (key === "oom_kill") {
          oomKill = parseCount(value ?? null);
        }
      }
      return { oom, oomKill };
    },

    async readCpuUsageMs(): Promise<number> {
      if (childPath === null) {
        return 0;
      }
      const text = await readControl(controlFile("cpu.stat"));
      if (text === null) {
        return 0;
      }
      for (const line of text.split("\n")) {
        const [key, value] = line.trim().split(/\s+/);
        if (key === "usage_usec") {
          return Math.round(parseCount(value ?? null) / 1000);
        }
      }
      return 0;
    },

    async countProcesses(): Promise<number> {
      if (childPath === null) {
        return 0;
      }
      const text = await readControl(controlFile("cgroup.procs"));
      if (text === null) {
        return 0;
      }
      return text.split("\n").filter((line) => line.trim() !== "").length;
    },

    async killAll(): Promise<boolean> {
      if (childPath === null) {
        return false;
      }
      try {
        await writeControl(controlFile("cgroup.kill"), "1");
        return true;
      } catch {
        return false;
      }
    },
  };
}
