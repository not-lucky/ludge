/** Fixed Linux process supervisor: cgroup v2, prlimit, bounded IO, cleanup. */

import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BoundedOutput,
  RawProcessResult,
  ResourceLimits,
} from "../domain/index.js";
import type { ArgvInvocation } from "./runner.js";
import type { CancellationToken } from "./cancellation.js";
import { createRunCgroup, type RunCgroup } from "./cgroup.js";
import { BoundedCollector } from "./output-collector.js";
import { terminateProcessTree } from "./reaper.js";
import { spawnChild, type SpawnPolicy } from "./spawn.js";

export interface LinuxSandboxConfig extends SpawnPolicy {
  readonly cgroupParentPath: string;
  readonly tempBaseDir: string;
  readonly sigtermGraceMs: number;
  /** Explicit local-development mode: omit cgroup setup, retain supervision. */
  readonly unsafeLocal: boolean;
  readonly benchmarkCpuWeight?: number;
  readonly clock: { monotonicNs(): bigint };
}

export function createLinuxSandbox(config: LinuxSandboxConfig) {
  return {
    async run(
      invocation: ArgvInvocation,
      input: Uint8Array,
      limits: ResourceLimits,
      cancellation: CancellationToken,
    ): Promise<RawProcessResult> {
      const setupStarted = config.clock.monotonicNs();
      let tempRoot: string | undefined;
      let cgroup: RunCgroup | undefined;
      try {
        await mkdir(config.tempBaseDir, { recursive: true });
        tempRoot = await mkdtemp(join(config.tempBaseDir, "run-"));
        if (!config.unsafeLocal) {
          cgroup = await createRunCgroup(
            config.cgroupParentPath,
            limits,
            config.benchmarkCpuWeight,
          );
        }
      } catch (error) {
        if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
        return failed(`setup failed: ${message(error)}`, setupStarted, config);
      }

      const cleanup: string[] = [];
      try {
        // `--unsafe-local` deliberately runs without sandbox enforcement. In
        // particular, applying RLIMIT_NPROC here breaks uv's Tokio runtime on
        // hosts whose existing process/thread count already approaches the
        // problem's per-submission cap. Keep the local wall/output supervisor,
        // but do not install the prlimit wrapper in this explicitly degraded
        // mode.
        const child = spawnChild(
          invocation,
          config,
          config.unsafeLocal ? [] : prlimit(limits),
        );
        const exit = watch(child);
        const stdout = new BoundedCollector(limits.stdoutBytes);
        const stderr = new BoundedCollector(limits.stderrBytes);
        let reason: "wall" | "output" | "cancel" | null = null;
        let reaping: Promise<void> | undefined;
        const stop = (next: NonNullable<typeof reason>) => {
          if (reason !== null) return;
          reason = next;
          if (cgroup) {
            // Do not race cgroup sampling/removal against descendant cleanup.
            // The exit event only proves the direct child died; descendants may
            // still be alive until the cgroup reaper has completed.
            reaping = terminateProcessTree(
              child,
              cgroup,
              config.sigtermGraceMs,
            ).then((facts) => {
              cleanup.push(...facts);
            });
          } else if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // The local child may have exited between the timer and signal.
            }
          }
        };
        const collect =
          (collector: BoundedCollector, other: BoundedCollector) =>
          (chunk: Buffer): void => {
            collector.push(chunk);
            if (
              collector.truncated ||
              other.truncated ||
              collector.totalBytes + other.totalBytes >
                limits.combinedOutputBytes
            )
              stop("output");
          };
        // Subscribe before closing stdin. A warm uv cache can make the harness
        // produce its complete response in the same turn as stdin EOF.
        child.stdout?.on("data", collect(stdout, stderr));
        child.stderr?.on("data", collect(stderr, stdout));
        if (child.pid !== undefined) await cgroup?.add(child.pid);
        child.stdin?.once("error", () => undefined);
        child.stdin?.end(input);
        const started = config.clock.monotonicNs();
        const timer = setTimeout(() => stop("wall"), limits.wallTimeMs);
        const unsubscribe = cancellation.onCancel(() => stop("cancel"));
        if (cancellation.isCancellationRequested) stop("cancel");
        const result = await exit;
        clearTimeout(timer);
        unsubscribe();
        await reaping;
        const stats = cgroup
          ? await cgroup.sample()
          : {
              memoryPeakBytes: 0,
              cpuTimeMs: 0,
              oomKills: 0,
              peakProcessCount: 0,
            };
        const ended = config.clock.monotonicNs();
        return {
          termination: result.error
            ? "spawn_failed"
            : reason === "wall"
              ? "timed_out"
              : reason === null
                ? result.signal
                  ? "signaled"
                  : "exited"
                : "killed",
          exitCode: result.code,
          signal: result.signal,
          stdout: stdout.toBoundedOutput(),
          stderr: stderr.toBoundedOutput(),
          resources: {
            wallTimeMs: Number((ended - started) / 1_000_000n),
            ...stats,
            ...(config.benchmarkCpuWeight === undefined
              ? {}
              : { cpuWeightApplied: cgroup?.cpuWeightApplied() ?? false }),
          },
          cleanupDiagnostics: cleanup,
          phases: {
            setupNs: started - setupStarted,
            targetNs: ended - started,
          },
        };
      } catch (error) {
        return failed(`spawn failed: ${message(error)}`, setupStarted, config);
      } finally {
        if (cgroup) cleanup.push(...(await cgroup.remove()));
        if (tempRoot)
          await rm(tempRoot, { recursive: true, force: true }).catch((error) =>
            cleanup.push(`temp root removal failed: ${message(error)}`),
          );
      }
    },
  };
}

function prlimit(limits: ResourceLimits): string[] {
  // RLIMIT_NPROC (--nproc) is deliberately omitted: it is a per-UID ceiling
  // that counts every process and thread owned by the user, not only those in
  // the current cgroup.  On a desktop with hundreds of existing threads the
  // limit false-positives and crashes uv's Tokio runtime before the target
  // even starts.  The cgroup's pids.max is the correct per-submission
  // enforcement and is always installed by createRunCgroup.
  return [
    "prlimit",
    `--cpu=${Math.max(1, Math.ceil(limits.cpuTimeMs / 1000))}`,
    `--as=${limits.memoryBytes}`,
    `--fsize=${limits.fileSizeBytes}`,
    `--nofile=${limits.openDescriptors}`,
    "--",
  ];
}
function watch(child: ChildProcess): Promise<{
  code: number | null;
  signal: string | null;
  error: Error | null;
}> {
  return new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({ code: null, signal: null, error }),
    );
    child.once("close", (code, signal) =>
      resolve({ code, signal, error: null }),
    );
  });
}
function empty(): BoundedOutput {
  return { data: new Uint8Array(), truncated: false, totalBytes: 0 };
}
function failed(
  reason: string,
  started: bigint,
  config: LinuxSandboxConfig,
): RawProcessResult {
  return {
    termination: "spawn_failed",
    exitCode: null,
    signal: null,
    stdout: empty(),
    stderr: empty(),
    resources: {
      wallTimeMs: 0,
      cpuTimeMs: 0,
      memoryPeakBytes: 0,
      oomKills: 0,
      peakProcessCount: 0,
    },
    cleanupDiagnostics: [reason],
    phases: { setupNs: config.clock.monotonicNs() - started, targetNs: null },
  };
}
function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
