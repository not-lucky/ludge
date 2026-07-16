/** Host facts and comparability labels used by the benchmark facade. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";

/** Immutable host/runtime facts persisted with a benchmark run. */
export interface BenchmarkEnvironmentFacts {
  readonly kernel: string;
  readonly cpuModel: string;
  readonly pythonVersion: string;
  readonly uvVersion: string;
  readonly nodeVersion: string;
  readonly sandboxMode: string;
  readonly databaseMode: string;
  readonly cpuGovernor: string | null;
  readonly cpuFrequency: string | null;
}

/** Read bounded Linux CPU metadata without making unavailable metadata fatal. */
export async function collectBenchmarkEnvironment(
  runtime: Readonly<{
    pythonVersion: string;
    uvVersion: string;
    sandboxMode: string;
    databaseMode: string;
  }>,
): Promise<BenchmarkEnvironmentFacts> {
  const [governor, frequency] = await Promise.all([
    firstCpuMetadata("scaling_governor"),
    firstCpuMetadata("scaling_cur_freq"),
  ]);
  return Object.freeze({
    kernel: `${platform()}-${release()}-${arch()}`.slice(0, 512),
    cpuModel: (cpus()[0]?.model ?? "unknown").slice(0, 512),
    pythonVersion: runtime.pythonVersion.slice(0, 128),
    uvVersion: runtime.uvVersion.slice(0, 128),
    nodeVersion: process.version.slice(0, 128),
    sandboxMode: runtime.sandboxMode.slice(0, 128),
    databaseMode: runtime.databaseMode.slice(0, 128),
    cpuGovernor: governor,
    cpuFrequency: frequency,
  });
}

/** Hash all persisted environment fields plus the serialized resource limits. */
export function fingerprintBenchmarkEnvironment(
  facts: BenchmarkEnvironmentFacts,
  limitsJson: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...facts, limitsJson }))
    .digest("hex");
}

async function firstCpuMetadata(name: string): Promise<string | null> {
  if (platform() !== "linux") return null;
  try {
    const value = (
      await readFile(`/sys/devices/system/cpu/cpu0/cpufreq/${name}`, "utf8")
    ).trim();
    return value.length === 0 ? null : value.slice(0, 128);
  } catch {
    return null;
  }
}
