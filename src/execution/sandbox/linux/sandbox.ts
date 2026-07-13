/**
 * The Linux full-enforcement {@link Sandbox} adapter.
 *
 * This is the concrete sandbox that runs one target invocation under enforced
 * resource limits and returns a bounded, adapter-neutral {@link RawProcessResult}.
 * It wires the sibling pieces into the exact lifecycle from
 * `docs/architecture/execution-sandbox.md`:
 *
 * 1. create the cgroup + temporary root and install every required control;
 * 2. verify enforcement is trustworthy (fail closed if a required control is
 *    absent — a normal pass is then impossible);
 * 3. spawn the argv invocation in a new session/process group;
 * 4. register the child in the cgroup before releasing supervisor control;
 * 5. stream stdout/stderr through bounded collectors that keep draining;
 * 6. monitor the wall deadline, cgroup memory/CPU/OOM, and output overflow;
 * 7. on deadline/cancellation, `SIGTERM` the group, wait the grace, then
 *    `SIGKILL` the group and remaining cgroup descendants;
 * 8. reap, tear down controls, remove the cgroup + temp root, and return the
 *    bounded result.
 *
 * `run` resolves with a `RawProcessResult` for every terminated process and for
 * every setup/spawn failure (as `termination: "spawn_failed"`); it never throws.
 * Status interpretation is a separate concern — see {@link classifyTermination}.
 *
 * This is an adapter module and may use Node builtins; it imports only ports,
 * domain values, and sibling files (never the CLI/application or the Python
 * runtime adapter), so it stays runtime-neutral.
 */

import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  BoundedOutput,
  RawProcessResult,
  ResourceLimits,
} from "../../../domain/index.js";
import type {
  ArgvInvocation,
  CancellationToken,
  Sandbox,
} from "../../ports/index.js";
import type { LinuxSandboxConfig } from "./config.js";
import { BoundedCollector } from "./output-collector.js";
import { RunMonitor } from "./monitor.js";
import { spawnChild } from "./spawn.js";
import { terminateProcessTree } from "./reaper.js";
import { probeEnforcement } from "./probe.js";
import type {
  CompositeInstallResult,
  ControlId,
  SandboxControl,
} from "./controls/control.js";
import { CompositeControls } from "./controls/control.js";
import { createCgroupv2Control } from "./controls/cgroup.js";
import type { Cgroupv2Control } from "./controls/cgroup.js";
import { createRlimitControl } from "./controls/rlimits.js";
import {
  createNamespacesControl,
  createNoNewPrivilegesControl,
} from "./controls/isolation.js";

/** Why the supervisor initiated termination (vs. the child ending on its own). */
type KillReason = "wall" | "output" | "cancel";

/** The observed end-of-life of the spawned child. */
interface ExitOutcome {
  /** Exit code, or `null` when signalled or never spawned. */
  readonly code: number | null;
  /** Terminating signal name, or `null` when exited normally. */
  readonly signal: string | null;
  /** The spawn error, when the child image could not be launched. */
  readonly spawnError: Error | null;
}

/** Render an unknown thrown value as a short diagnostic string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An empty bounded-output value for results with no captured bytes. */
function emptyOutput(): BoundedOutput {
  return { data: new Uint8Array(), truncated: false, totalBytes: 0 };
}

/**
 * Build a fail-closed {@link RawProcessResult}.
 *
 * Used for every pre-verdict failure (unsupported host, partial setup, cgroup
 * registration failure). `termination: "spawn_failed"` guarantees the classifier
 * yields a tier-0 setup/spawn status — never `passed`.
 */
function failClosed(
  reasons: readonly string[],
  cleanupDiagnostics: readonly string[] = [],
): RawProcessResult {
  return {
    termination: "spawn_failed",
    exitCode: null,
    signal: null,
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    resources: {
      wallTimeMs: 0,
      cpuTimeMs: 0,
      memoryPeakBytes: 0,
      oomKills: 0,
      peakProcessCount: 0,
    },
    cleanupDiagnostics: [...reasons, ...cleanupDiagnostics],
  };
}

/**
 * Assemble the ordered control set for a configuration.
 *
 * Order fixes how wrapper prefixes nest: namespaces (outermost) → privilege
 * drop → rlimits (innermost) → the target. The cgroup control contributes no
 * prefix but is created first so its child cgroup exists before the child is
 * spawned. A control is `required` iff it is named in `config.requiredControls`.
 */
function buildControls(config: LinuxSandboxConfig): {
  readonly cgroup: Cgroupv2Control;
  readonly composite: CompositeControls;
} {
  const isRequired = (id: ControlId): boolean =>
    config.requiredControls.includes(id);

  const cgroup = createCgroupv2Control(
    config.cgroupParentPath,
    isRequired("cgroup"),
  );
  const controls: readonly SandboxControl[] = [
    cgroup,
    createNamespacesControl(isRequired("namespaces")),
    createNoNewPrivilegesControl(isRequired("no-new-privileges")),
    createRlimitControl(isRequired("rlimits")),
  ];
  return { cgroup, composite: new CompositeControls(controls) };
}

/** Resolve the child's end-of-life via its `close`/`error` events. */
function watchChild(child: ChildProcess): Promise<ExitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: ExitOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    child.once("error", (error: Error) => {
      settle({ code: null, signal: null, spawnError: error });
    });
    // `close` fires once stdio has flushed, so the collectors have every byte.
    child.once("close", (code, signal) => {
      settle({ code, signal, spawnError: null });
    });
  });
}

/** Map the raw outcome and any supervisor kill onto a {@link TerminationKind}. */
function deriveTermination(
  outcome: ExitOutcome,
  killReason: KillReason | null,
): RawProcessResult["termination"] {
  if (outcome.spawnError !== null) {
    return "spawn_failed";
  }
  if (killReason === "wall") {
    return "timed_out";
  }
  if (killReason !== null) {
    return "killed";
  }
  return outcome.signal !== null ? "signaled" : "exited";
}

/** Remove a temporary root, returning any removal problem as a diagnostic. */
async function removeTempRoot(path: string): Promise<readonly string[]> {
  try {
    await rm(path, { recursive: true, force: true });
    return [];
  } catch (error) {
    return [`temp root removal failed for '${path}': ${describeError(error)}`];
  }
}

/**
 * Create the Linux full-enforcement {@link Sandbox}.
 *
 * @typeParam Tag - The owning backend's coherence tag.
 * @param backendId - The backend this sandbox belongs to.
 * @param config - The validated, frozen sandbox configuration.
 * @returns A {@link Sandbox} branded with `backendId`.
 */
export function createLinuxSandbox<Tag extends string>(
  backendId: Tag,
  config: LinuxSandboxConfig,
): Sandbox<Tag> {
  return {
    backendId,

    async run(
      invocation: ArgvInvocation,
      input: Uint8Array,
      limits: ResourceLimits,
      cancellation: CancellationToken,
    ): Promise<RawProcessResult> {
      const clock = config.clock;
      const { cgroup, composite } = buildControls(config);

      // --- Step 2 (gate): fail closed on an untrustworthy host --------------
      const optionalMissing = await composite.optionalUnavailable();
      const decision = await probeEnforcement(composite, optionalMissing);
      if (decision.mode === "unsupported") {
        return failClosed(decision.reasons);
      }

      // --- Step 1: temporary root + install every required control ----------
      const cleanupDiagnostics: string[] = [];
      let tempRoot: string | null = null;
      let install: CompositeInstallResult | null = null;
      try {
        await mkdir(config.tempBaseDir, { recursive: true });
        tempRoot = await mkdtemp(join(config.tempBaseDir, "run-"));
        install = await composite.install({ limits, tempRoot, config });
      } catch (error) {
        if (install !== null) {
          cleanupDiagnostics.push(...(await install.teardown()));
        }
        if (tempRoot !== null) {
          cleanupDiagnostics.push(...(await removeTempRoot(tempRoot)));
        }
        return failClosed([`setup failed: ${describeError(error)}`], cleanupDiagnostics);
      }

      // From here a spawned child and installed controls must always be cleaned
      // up before returning, so the remaining steps run under a finally.
      const stdout = new BoundedCollector(limits.stdoutBytes);
      const stderr = new BoundedCollector(limits.stderrBytes);
      const monitor = new RunMonitor(cgroup);
      const startNs = clock.monotonicNs();

      let child: ChildProcess;
      try {
        // --- Step 3: spawn in a new session/process group -----------------
        child = spawnChild(invocation, config, install.argvPrefix);
      } catch (error) {
        cleanupDiagnostics.push(...(await install.teardown()));
        cleanupDiagnostics.push(...(await removeTempRoot(tempRoot)));
        return failClosed([`spawn failed: ${describeError(error)}`], cleanupDiagnostics);
      }

      const exit = watchChild(child);
      // The application has already canonicalized and bounded this exact
      // request-envelope byte sequence. End stdin immediately after writing so
      // the one-request JSONL harness can begin evaluation deterministically.
      // A target can exit before consuming stdin; EPIPE is then an ordinary raw
      // target fact, not an uncaught supervisor error.
      child.stdin?.once("error", () => undefined);
      child.stdin?.end(input);
      let killReason: KillReason | null = null;
      const requestTerminate = (reason: KillReason): void => {
        if (killReason === null) {
          killReason = reason;
        }
        void terminateProcessTree(child, cgroup, config.sigtermGraceMs);
      };

      // --- Step 5: bounded output collection with overflow detection --------
      const overflowed = (): boolean =>
        stdout.truncated ||
        stderr.truncated ||
        stdout.totalBytes + stderr.totalBytes > limits.combinedOutputBytes;
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        if (overflowed()) {
          requestTerminate("output");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        if (overflowed()) {
          requestTerminate("output");
        }
      });

      // --- Step 4: register the PID before releasing control ----------------
      if (child.pid !== undefined) {
        try {
          await cgroup.registerPid(child.pid);
        } catch (error) {
          await terminateProcessTree(child, cgroup, config.sigtermGraceMs);
          await exit;
          cleanupDiagnostics.push(...(await install.teardown()));
          cleanupDiagnostics.push(...(await removeTempRoot(tempRoot)));
          return failClosed(
            [`cgroup registration failed: ${describeError(error)}`],
            cleanupDiagnostics,
          );
        }
      }

      // --- Step 6: monitor deadlines, cancellation, and cgroup events -------
      monitor.start();
      const wallTimer = setTimeout(
        () => requestTerminate("wall"),
        limits.wallTimeMs,
      );
      wallTimer.unref?.();
      const unsubscribe = cancellation.onCancel(() => requestTerminate("cancel"));
      if (cancellation.isCancellationRequested) {
        requestTerminate("cancel");
      }

      // --- Step 7: await termination (natural or supervisor-initiated) ------
      const outcome = await exit;

      clearTimeout(wallTimer);
      unsubscribe();
      await monitor.stop();

      const snapshot = monitor.snapshot();
      const wallTimeMs = Number((clock.monotonicNs() - startNs) / 1_000_000n);

      // --- Step 8: reap, tear down controls, remove temp root, return -------
      cleanupDiagnostics.push(...(await install.teardown()));
      cleanupDiagnostics.push(...(await removeTempRoot(tempRoot)));

      return {
        termination: deriveTermination(outcome, killReason),
        exitCode: outcome.code,
        signal: outcome.signal,
        stdout: stdout.toBoundedOutput(),
        stderr: stderr.toBoundedOutput(),
        resources: {
          wallTimeMs,
          cpuTimeMs: snapshot.cpuTimeMs,
          memoryPeakBytes: snapshot.memoryPeakBytes,
          oomKills: snapshot.oomKills,
          peakProcessCount: snapshot.peakProcessCount,
        },
        cleanupDiagnostics,
      };
    },
  };
}
