/**
 * `PALESTRA_*` environment-variable overrides.
 *
 * The precedence chain reserves the `PALESTRA_*` namespace for a fixed set of
 * global paths and resource defaults — never arbitrary `problem.yaml`-key
 * overrides. This module reads exactly those reserved names into a structured
 * {@link EnvOverrides}; any unknown `PALESTRA_*` variable is simply not consulted
 * here (it has no meaning), and malformed integer values fail closed with a
 * configuration error rather than being coerced.
 *
 * This is infrastructure and reads a plain environment record; it performs no
 * filesystem access (path *validation* is the validator's job).
 */

import type { ResourceLimitsSpec } from "../../domain/index.js";
import { ConfigError } from "./errors.js";
import type { ProblemLimitOverrides } from "./problem-config.js";

/**
 * Host-global paths and resource locations, injected from the environment and
 * (later) overridable by CLI flags. These are deliberately NOT part of
 * `problem.yaml`: they describe where this machine keeps `uv`, Python, caches,
 * and the sandbox's cgroup/temp roots.
 */
export interface GlobalPaths {
  /** Absolute path to the real `uv` executable. */
  readonly uvPath: string;
  /** Absolute path to the Python interpreter `uv` should select. */
  readonly pythonPath: string;
  /** Absolute `uv` cache directory placed in the child environment. */
  readonly uvCacheDir: string;
  /** Absolute base directory under which each run's temp root is created. */
  readonly tempBaseDir: string;
  /** Absolute supervisor-owned cgroup v2 parent directory. */
  readonly cgroupParentPath: string;
}

/** Structured `PALESTRA_*` overrides: partial global paths and limit defaults. */
export interface EnvOverrides {
  /** Global paths present in the environment (any subset). */
  readonly paths: Partial<GlobalPaths>;
  /** Resource-limit defaults present in the environment (any subset). */
  readonly limits: ProblemLimitOverrides;
  /** Optional total fuzz-artifact storage ceiling; omission means unlimited. */
  readonly artifactStorageCapBytes: number | undefined;
}

/** Reserved environment names mapped to their {@link GlobalPaths} field. */
const PATH_ENV_MAP: Readonly<Record<string, keyof GlobalPaths>> = {
  PALESTRA_UV_PATH: "uvPath",
  PALESTRA_PYTHON_PATH: "pythonPath",
  PALESTRA_UV_CACHE_DIR: "uvCacheDir",
  PALESTRA_TEMP_DIR: "tempBaseDir",
  PALESTRA_CGROUP_PARENT: "cgroupParentPath",
};

/** Reserved environment names mapped to their resource-limit field. */
const LIMIT_ENV_MAP: Readonly<Record<string, keyof ResourceLimitsSpec>> = {
  PALESTRA_WALL_TIME_MS: "wallTimeMs",
  PALESTRA_CPU_TIME_MS: "cpuTimeMs",
  PALESTRA_MEMORY_BYTES: "memoryBytes",
  PALESTRA_STDOUT_BYTES: "stdoutBytes",
  PALESTRA_STDERR_BYTES: "stderrBytes",
  PALESTRA_COMBINED_OUTPUT_BYTES: "combinedOutputBytes",
  PALESTRA_INPUT_BYTES: "inputBytes",
  PALESTRA_FILE_SIZE_BYTES: "fileSizeBytes",
  PALESTRA_PROCESS_COUNT: "processCount",
  PALESTRA_OPEN_DESCRIPTORS: "openDescriptors",
  PALESTRA_TEMP_STORAGE_BYTES: "tempStorageBytes",
  PALESTRA_CONCURRENCY_PER_CASE: "concurrencyPerCase",
};

/** A read-only view of the process environment. */
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

/**
 * Read the reserved `PALESTRA_*` variables into structured overrides.
 *
 * A path variable contributes its trimmed value (an empty value is treated as
 * absent). A limit variable is parsed as a positive, bounded integer; a
 * non-integer, non-positive, or out-of-range value is rejected.
 *
 * @param env - The environment record (typically `process.env`).
 * @returns The structured overrides drawn from the reserved namespace.
 * @throws {ConfigError} If a reserved limit variable holds a malformed integer.
 */
export function parseEnvOverrides(env: EnvironmentRecord): EnvOverrides {
  const paths: Partial<Record<keyof GlobalPaths, string>> = {};
  for (const [name, field] of Object.entries(PATH_ENV_MAP)) {
    const raw = env[name];
    if (raw !== undefined && raw.trim().length > 0) {
      paths[field] = raw.trim();
    }
  }

  const limits: Partial<Record<keyof ResourceLimitsSpec, number>> = {};
  for (const [name, field] of Object.entries(LIMIT_ENV_MAP)) {
    const raw = env[name];
    if (raw !== undefined && raw.trim().length > 0) {
      limits[field] = parseEnvInt(name, raw.trim());
    }
  }

  const rawArtifactCap = env.PALESTRA_ARTIFACT_STORAGE_CAP_BYTES;
  const artifactStorageCapBytes = rawArtifactCap === undefined || rawArtifactCap.trim().length === 0
    ? undefined
    : parseEnvInt("PALESTRA_ARTIFACT_STORAGE_CAP_BYTES", rawArtifactCap.trim());

  return { paths, limits, artifactStorageCapBytes };
}

/**
 * Parse a reserved-variable integer, bounding it before conversion.
 *
 * @param name - The environment variable name (for diagnostics).
 * @param raw - The trimmed value text.
 * @returns The positive, safe-integer value.
 * @throws {ConfigError} If the value is not a positive, representable integer.
 */
function parseEnvInt(name: string, raw: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new ConfigError(
      `environment variable ${name} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(
      `environment variable ${name} must be a positive integer within the safe range, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
