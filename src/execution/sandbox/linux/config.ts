/**
 * Configuration for the Linux full-enforcement sandbox.
 *
 * The {@link Sandbox} port's `run(invocation, limits, cancellation)` carries only
 * what to launch and the resource ceilings — it deliberately says nothing about
 * *where* the child runs, *which* environment it sees, or *what* it may read.
 * Those are host-specific policy, so they are injected once at construction
 * through a validated, frozen {@link LinuxSandboxConfig}. The composition root
 * (task 11) wires the Python launch plan's working directory and sanitized
 * environment into this config; the sandbox itself stays runtime-neutral and
 * never imports the Python adapter.
 *
 * This module uses no Node builtins: it only fixes the config shape and rejects
 * blatantly malformed values so a misconfiguration fails closed with a precise
 * message rather than as an opaque spawn error.
 */

import type { Clock } from "../../ports/index.js";
import type { ControlId } from "./controls/ids.js";

/**
 * The set of controls that MUST be installable for a run to be trusted.
 *
 * If a required control cannot be probed and installed, the run fails closed:
 * the sandbox never spawns a normally-classifiable child, so a `passed` verdict
 * is impossible when a required boundary is absent (see
 * `docs/architecture/execution-sandbox.md` § Status mapping and fail closed).
 */
export type RequiredControls = readonly ControlId[];

/**
 * A validated, frozen configuration for one Linux sandbox instance.
 *
 * Every path is a host-absolute location resolved by the caller; the sandbox
 * treats them as opaque and never reads or evaluates the files they point at.
 * `environment` is the complete, allow-listed environment handed to the child —
 * no host environment is inherited.
 */
export interface LinuxSandboxConfig {
  /** Child working directory (the run/problem root the target launches in). */
  readonly workingDirectory: string;
  /**
   * The exact, allow-listed environment for the child process.
   *
   * The sandbox contract permits only `PATH`, locale (`LANG`),
   * `PYTHONUNBUFFERED`, and `UV_CACHE_DIR`; this record is passed verbatim as the
   * child's entire environment.
   */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Absolute paths the child may read but never write (problem files, the
   * Python/uv runtime assets, and configured read-only dependencies). Used to
   * build the child's restricted filesystem view.
   */
  readonly readonlyPaths: readonly string[];
  /**
   * Absolute path to the supervisor-owned cgroup v2 parent directory (a
   * delegated subtree of the unified hierarchy, e.g. `…/palestra`). Each run
   * creates a fresh child cgroup beneath it.
   */
  readonly cgroupParentPath: string;
  /** Absolute base directory under which each run's temporary root is created. */
  readonly tempBaseDir: string;
  /**
   * Milliseconds to wait after `SIGTERM` before escalating to `SIGKILL` on a
   * deadline or cancellation. Defaults to `100` per the lifecycle spec.
   */
  readonly sigtermGraceMs: number;
  /** Controls that MUST install successfully or the run fails closed. */
  readonly requiredControls: RequiredControls;
  /**
   * Clock used for wall-time observation, injected for deterministic tests. The
   * factory falls back to a Node-backed clock when omitted.
   */
  readonly clock: Clock;
}

/**
 * Field-by-field specification used to construct a {@link LinuxSandboxConfig}.
 *
 * `sigtermGraceMs`, `requiredControls`, and `clock` are optional and defaulted;
 * every other field is required.
 */
export interface LinuxSandboxConfigSpec {
  /** See {@link LinuxSandboxConfig.workingDirectory}. */
  readonly workingDirectory: string;
  /** See {@link LinuxSandboxConfig.environment}. */
  readonly environment: Readonly<Record<string, string>>;
  /** See {@link LinuxSandboxConfig.readonlyPaths}. Defaults to empty. */
  readonly readonlyPaths?: readonly string[];
  /** See {@link LinuxSandboxConfig.cgroupParentPath}. */
  readonly cgroupParentPath: string;
  /** See {@link LinuxSandboxConfig.tempBaseDir}. */
  readonly tempBaseDir: string;
  /** See {@link LinuxSandboxConfig.sigtermGraceMs}. Defaults to `100`. */
  readonly sigtermGraceMs?: number;
  /** See {@link LinuxSandboxConfig.requiredControls}. Defaults to `["cgroup"]`. */
  readonly requiredControls?: RequiredControls;
  /** See {@link LinuxSandboxConfig.clock}. Defaults to a Node-backed clock. */
  readonly clock?: Clock;
}

/** The lifecycle default `SIGTERM`→`SIGKILL` grace window, in milliseconds. */
export const DEFAULT_SIGTERM_GRACE_MS = 100;

/**
 * The controls required by default: the cgroup boundary is the authoritative
 * memory/pids/kill mechanism, so it is fail-closed out of the box.
 */
export const DEFAULT_REQUIRED_CONTROLS: RequiredControls = ["cgroup"];

/** Absolute-path fields that must be non-empty, absolute host paths. */
const ABSOLUTE_PATH_FIELDS: readonly (keyof LinuxSandboxConfig)[] = [
  "workingDirectory",
  "cgroupParentPath",
  "tempBaseDir",
];

/**
 * A minimal Node-backed {@link Clock} used when the caller injects none.
 *
 * `monotonicNs` reads the high-resolution monotonic timer; `wallTimeUtc` renders
 * the current instant as ISO-8601 UTC. Kept private so the sandbox has a working
 * default without forcing every caller to supply a clock.
 */
function defaultClock(): Clock {
  return {
    monotonicNs(): bigint {
      return process.hrtime.bigint();
    },
    wallTimeUtc(): string {
      return new Date().toISOString();
    },
  };
}

/**
 * Build a validated, frozen {@link LinuxSandboxConfig}.
 *
 * Path fields must be non-empty and absolute (a relative path here almost always
 * means a missing binding that would later spawn the child in the wrong place).
 * `sigtermGraceMs` must be a positive safe integer. `environment` and
 * `readonlyPaths` are defensively copied and frozen so a caller cannot mutate the
 * config after construction.
 *
 * @param spec - The configuration values.
 * @returns A deeply frozen {@link LinuxSandboxConfig}.
 * @throws {RangeError} If a path field is blank/relative or `sigtermGraceMs` is
 *   not a positive safe integer.
 */
export function createLinuxSandboxConfig(
  spec: LinuxSandboxConfigSpec,
): LinuxSandboxConfig {
  const sigtermGraceMs = spec.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;

  const config: LinuxSandboxConfig = {
    workingDirectory: spec.workingDirectory,
    environment: Object.freeze({ ...spec.environment }),
    readonlyPaths: Object.freeze([...(spec.readonlyPaths ?? [])]),
    cgroupParentPath: spec.cgroupParentPath,
    tempBaseDir: spec.tempBaseDir,
    sigtermGraceMs,
    requiredControls: Object.freeze([
      ...(spec.requiredControls ?? DEFAULT_REQUIRED_CONTROLS),
    ]),
    clock: spec.clock ?? defaultClock(),
  };

  for (const field of ABSOLUTE_PATH_FIELDS) {
    const value = config[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RangeError(
        `linux sandbox config '${field}' must be a non-empty string`,
      );
    }
    if (!value.startsWith("/")) {
      throw new RangeError(
        `linux sandbox config '${field}' must be an absolute path, got '${value}'`,
      );
    }
  }

  if (!Number.isSafeInteger(sigtermGraceMs) || sigtermGraceMs <= 0) {
    throw new RangeError(
      `linux sandbox config 'sigtermGraceMs' must be a positive safe integer, got ${String(sigtermGraceMs)}`,
    );
  }

  return Object.freeze(config);
}
