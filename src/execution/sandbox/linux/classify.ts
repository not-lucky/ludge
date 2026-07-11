/**
 * Termination-cause classification (Chain of Responsibility).
 *
 * The {@link Sandbox} port returns a faithful, adapter-neutral
 * {@link RawProcessResult}: how the child terminated, its raw exit code/signal,
 * bounded output with truncation flags, and sampled resource observations. It
 * assigns no verdict. {@link classifyTermination} is the pure function that maps
 * that raw observation — together with the {@link ResourceLimits} that were in
 * force — onto a single stable {@link TerminationCause}, honoring the severity
 * precedence defined once in the domain
 * (`EXECUTION_STATUS_PRECEDENCE`).
 *
 * Keeping this classification pure and separate lets the `test` command (task
 * 12) reuse it, and lets it be unit-tested against crafted results without a
 * real sandbox. `wrong_answer` and `passed` are the two least-severe causes: a
 * clean exit yields `passed` here, and the comparator may later downgrade a
 * `passed` execution to `wrong_answer` — that decision is NOT made in this
 * module.
 *
 * This module is pure: it imports only domain value types and the precedence
 * helpers; no Node or adapter import.
 */

import type {
  RawProcessResult,
  ResourceLimits,
  TerminationCause,
} from "../../../domain/index.js";
import { mostSevere } from "../../../domain/index.js";

/**
 * Signals whose delivery unambiguously names a resource breach.
 *
 * `SIGXCPU` is raised when `RLIMIT_CPU` is exceeded (defense-in-depth CPU
 * ceiling) and `SIGXFSZ` when `RLIMIT_FSIZE` is exceeded (a write past the file
 * ceiling). They are the only reliable in-band evidence of `tle_cpu`/`file_limit`
 * carried by the raw result's `signal` field.
 */
const SIGNAL_CPU_LIMIT = "SIGXCPU";
const SIGNAL_FILE_LIMIT = "SIGXFSZ";

/**
 * Collect every termination cause the raw result exhibits.
 *
 * A single execution can trip several signals at once (for example a process
 * that both blew the memory ceiling and was then killed by signal); each link
 * below contributes the cause it recognizes, and {@link mostSevere} resolves the
 * winner by domain precedence. The order of pushes is irrelevant — precedence,
 * not push order, decides the outcome.
 */
function observedCauses(
  raw: RawProcessResult,
  limits: ResourceLimits,
): TerminationCause[] {
  const causes: TerminationCause[] = [];

  // --- Tier 0: setup / spawn failures ------------------------------------
  // A child that never spawned (partial setup, missing runtime, or a required
  // control that could not be installed) fails closed: the most severe tier,
  // never a normal pass.
  if (raw.termination === "spawn_failed") {
    causes.push("spawn_error");
    return causes;
  }

  // --- Tier 1: resource-limit breaches -----------------------------------
  // CPU: the authoritative wall/cgroup evidence is the CPU observation; the
  // SIGXCPU rlimit signal is corroborating defense-in-depth.
  if (
    raw.signal === SIGNAL_CPU_LIMIT ||
    raw.resources.cpuTimeMs >= limits.cpuTimeMs
  ) {
    causes.push("tle_cpu");
  }
  // Wall: a wall-deadline kill surfaces as `timed_out`, or the sampled wall
  // duration reaching the ceiling.
  if (
    raw.termination === "timed_out" ||
    raw.resources.wallTimeMs >= limits.wallTimeMs
  ) {
    causes.push("tle_wall");
  }
  // Memory: an OOM kill counter, or a sampled peak at/above the cgroup ceiling.
  if (
    raw.resources.oomKills > 0 ||
    raw.resources.memoryPeakBytes >= limits.memoryBytes
  ) {
    causes.push("mle");
  }
  // Output: either stream truncated at its cap, or the combined byte budget
  // exceeded across both streams.
  const combinedBytes = raw.stdout.totalBytes + raw.stderr.totalBytes;
  if (
    raw.stdout.truncated ||
    raw.stderr.truncated ||
    combinedBytes > limits.combinedOutputBytes
  ) {
    causes.push("output_limit");
  }
  // File: a write past the file-size rlimit delivers SIGXFSZ.
  if (raw.signal === SIGNAL_FILE_LIMIT) {
    causes.push("file_limit");
  }
  // Process: the peak live process count reached the ceiling.
  if (raw.resources.peakProcessCount >= limits.processCount) {
    causes.push("process_limit");
  }

  // --- Tiers 3–4: signal / exit ------------------------------------------
  // Any other terminating signal that is not one of the resource signals above.
  if (
    raw.signal !== null &&
    raw.signal !== SIGNAL_CPU_LIMIT &&
    raw.signal !== SIGNAL_FILE_LIMIT
  ) {
    causes.push("signaled");
  }
  // A nonzero, non-signal exit code.
  if (raw.termination === "exited" && raw.exitCode !== null && raw.exitCode !== 0) {
    causes.push("nonzero_exit");
  }

  // --- Tier 6: the baseline -----------------------------------------------
  // A clean, in-limit exit is `passed`; the comparator decides `wrong_answer`
  // later. `passed` always participates so there is at least one cause.
  causes.push("passed");
  return causes;
}

/**
 * Classify a raw process observation into its single most severe termination
 * cause.
 *
 * `protocol_error` is intentionally not decided here: it depends on parsing the
 * response envelope, which is the codec/comparator's concern (task 04/05), not
 * the sandbox's. Everything else in the termination-cause precedence is derivable
 * from the raw result plus the limits and is classified below.
 *
 * @param raw - The bounded observation returned by the sandbox.
 * @param limits - The resource ceilings that were in force for the run.
 * @returns The highest-precedence {@link TerminationCause} the result exhibits.
 */
export function classifyTermination(
  raw: RawProcessResult,
  limits: ResourceLimits,
): TerminationCause {
  const [first, ...rest] = observedCauses(raw, limits);
  // `observedCauses` always pushes at least `passed`, so `first` is defined.
  return mostSevere(first!, ...rest);
}
