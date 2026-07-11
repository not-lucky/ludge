/**
 * Resource monitor — samples the live cgroup during a run.
 *
 * While the target runs, the supervisor periodically reads the cgroup's memory
 * peak, CPU usage, OOM counters, and live process count, keeping the running
 * maxima. These become the {@link ResourceObservations} on the raw result and
 * are the evidence the classifier uses for `mle`, `tle_cpu`, and `process_limit`.
 *
 * The monitor only observes — it never kills. The authoritative kill decisions
 * (wall deadline, cancellation, output overflow) belong to the sandbox
 * lifecycle, while the kernel itself enforces the cgroup memory ceiling and the
 * `RLIMIT_CPU` signal. Sampling is re-entrancy guarded so a slow read never
 * overlaps the next tick.
 *
 * This is an adapter module and may use Node builtins.
 */

import type { Cgroupv2Control } from "./controls/cgroup.js";

/** Default interval between cgroup samples, in milliseconds. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 20;

/** The running maxima the monitor has observed. */
export interface MonitorSnapshot {
  /** Peak descendant cgroup memory in bytes. */
  readonly memoryPeakBytes: number;
  /** Most recent cumulative CPU time in milliseconds. */
  readonly cpuTimeMs: number;
  /** Count of cgroup OOM-kill events observed. */
  readonly oomKills: number;
  /** Peak live process count observed. */
  readonly peakProcessCount: number;
}

/**
 * Periodically samples a run's cgroup and retains the peak observations.
 */
export class RunMonitor {
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private memoryPeakBytes = 0;
  private cpuTimeMs = 0;
  private oomKills = 0;
  private peakProcessCount = 0;

  /**
   * @param cgroup - The cgroup control to sample.
   * @param intervalMs - Sampling period; defaults to {@link DEFAULT_SAMPLE_INTERVAL_MS}.
   */
  public constructor(
    private readonly cgroup: Cgroupv2Control,
    private readonly intervalMs: number = DEFAULT_SAMPLE_INTERVAL_MS,
  ) {}

  /** Begin periodic sampling. Idempotent while already running. */
  public start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.intervalMs);
    // Do not let the sampler keep the event loop alive on its own.
    this.timer.unref?.();
  }

  /** Stop sampling and take one final synchronous-style sample. */
  public async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.sampleOnce();
  }

  /**
   * Read the cgroup once and fold the readings into the running maxima.
   *
   * Guarded against re-entrancy: if a previous sample is still in flight this
   * tick is skipped rather than queued.
   */
  private async sampleOnce(): Promise<void> {
    if (this.sampling) {
      return;
    }
    this.sampling = true;
    try {
      const [memoryPeak, cpuMs, events, procs] = await Promise.all([
        this.cgroup.sampleMemoryPeakBytes(),
        this.cgroup.readCpuUsageMs(),
        this.cgroup.readMemoryEvents(),
        this.cgroup.countProcesses(),
      ]);
      this.memoryPeakBytes = Math.max(this.memoryPeakBytes, memoryPeak);
      this.cpuTimeMs = Math.max(this.cpuTimeMs, cpuMs);
      this.oomKills = Math.max(this.oomKills, events.oomKill);
      this.peakProcessCount = Math.max(this.peakProcessCount, procs);
    } finally {
      this.sampling = false;
    }
  }

  /**
   * The current running maxima.
   *
   * @returns A snapshot of the peak observations gathered so far.
   */
  public snapshot(): MonitorSnapshot {
    return {
      memoryPeakBytes: this.memoryPeakBytes,
      cpuTimeMs: this.cpuTimeMs,
      oomKills: this.oomKills,
      peakProcessCount: this.peakProcessCount,
    };
  }
}
