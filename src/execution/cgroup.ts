/** Fixed cgroup-v2 boundary used by every normal Linux run. */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ResourceLimits } from "../domain/index.js";

export interface CgroupStats {
  readonly memoryPeakBytes: number;
  readonly cpuTimeMs: number;
  readonly oomKills: number;
  readonly peakProcessCount: number;
}

export interface RunCgroup {
  add(pid: number): Promise<void>;
  sample(): Promise<CgroupStats>;
  killAll(): Promise<boolean>;
  remove(): Promise<readonly string[]>;
  cpuWeightApplied(): boolean;
}

export async function createRunCgroup(
  parent: string,
  limits: ResourceLimits,
  benchmarkCpuWeight: number | undefined,
): Promise<RunCgroup> {
  if (process.platform !== "linux")
    throw new Error("Linux cgroup v2 is required");
  await access(join(parent, "cgroup.controllers"), constants.R_OK);
  await access(parent, constants.W_OK | constants.X_OK);
  await write(
    parent,
    "cgroup.subtree_control",
    benchmarkCpuWeight === undefined ? "+memory +pids" : "+memory +pids +cpu",
  ).catch(() => undefined);

  const path = join(parent, `run-${randomUUID()}`);
  await mkdir(path);
  try {
    await Promise.all([
      write(path, "memory.max", String(limits.memoryBytes)),
      write(path, "pids.max", String(limits.processCount)),
    ]);
    await write(path, "memory.swap.max", "0").catch(() => undefined);
    let cpuWeightApplied = false;
    if (benchmarkCpuWeight !== undefined) {
      try {
        await write(path, "cpu.weight", String(benchmarkCpuWeight));
        cpuWeightApplied = true;
      } catch {
        // Benchmark code labels this sample non-comparable from the raw fact.
      }
    }
    return {
      async add(pid) {
        try {
          await write(path, "cgroup.procs", String(pid));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
      async sample() {
        const [peak, current, cpu, events, procs] = await Promise.all([
          read(path, "memory.peak"),
          read(path, "memory.current"),
          read(path, "cpu.stat"),
          read(path, "memory.events"),
          read(path, "cgroup.procs"),
        ]);
        return {
          memoryPeakBytes: count(peak) || count(current),
          cpuTimeMs: cpuUsage(cpu),
          oomKills: eventCount(events, "oom_kill"),
          peakProcessCount: procs?.split("\n").filter(Boolean).length ?? 0,
        };
      },
      async killAll() {
        try {
          await write(path, "cgroup.kill", "1");
          return true;
        } catch {
          return false;
        }
      },
      async remove() {
        try {
          await rm(path, { recursive: true, force: true });
          return [];
        } catch (error) {
          return [`cgroup removal failed: ${message(error)}`];
        }
      },
      cpuWeightApplied: () => cpuWeightApplied,
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

async function write(root: string, name: string, value: string): Promise<void> {
  await writeFile(join(root, name), `${value}\n`);
}
async function read(root: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(root, name), "utf8");
  } catch {
    return null;
  }
}
function count(value: string | null): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
function cpuUsage(value: string | null): number {
  const line = value
    ?.split("\n")
    .find((item) => item.startsWith("usage_usec "));
  return Math.round(count(line?.split(/\s+/)[1] ?? null) / 1000);
}
function eventCount(value: string | null, name: string): number {
  const line = value?.split("\n").find((item) => item.startsWith(`${name} `));
  return count(line?.split(/\s+/)[1] ?? null);
}
function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
