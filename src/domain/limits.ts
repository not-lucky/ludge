/**
 * Immutable per-execution resource limits.
 *
 * These are the runtime-neutral value contracts consumed by the sandbox port.
 * The field set mirrors the limits table in
 * `docs/architecture/execution-sandbox.md`; concrete defaults and configuration
 * precedence are the concern of the configuration layer (task 08), not the
 * domain. This module only defines the shape and enforces that a constructed
 * value is well-formed and frozen.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/**
 * A coherent set of resource ceilings for a single target execution.
 *
 * Every field is a positive integer. Byte fields are absolute byte counts and
 * time fields are whole milliseconds. A value of this type is deeply frozen and
 * must be created through {@link createResourceLimits}.
 */
export interface ResourceLimits {
  /** Wall-clock deadline in milliseconds; exceeding it maps to `tle_wall`. */
  readonly wallTimeMs: number;
  /** CPU-time deadline in milliseconds; exceeding it maps to `tle_cpu`. */
  readonly cpuTimeMs: number;
  /** Descendant cgroup memory ceiling in bytes; exceeding it maps to `mle`. */
  readonly memoryBytes: number;
  /** Bounded stdout capture ceiling in bytes. */
  readonly stdoutBytes: number;
  /** Bounded stderr capture ceiling in bytes. */
  readonly stderrBytes: number;
  /** Combined stdout+stderr ceiling in bytes; exceeding it maps to `output_limit`. */
  readonly combinedOutputBytes: number;
  /** Maximum accepted request input size in bytes. */
  readonly inputBytes: number;
  /** Per-file write ceiling in bytes; exceeding it maps to `file_limit`. */
  readonly fileSizeBytes: number;
  /** Maximum live process count; exceeding it maps to `process_limit`. */
  readonly processCount: number;
  /** Maximum open file descriptors. */
  readonly openDescriptors: number;
  /** Temporary-storage ceiling for the run directory in bytes. */
  readonly tempStorageBytes: number;
  /** Concurrent executions permitted per test case. */
  readonly concurrencyPerCase: number;
}

/** Field-by-field specification used to construct {@link ResourceLimits}. */
export type ResourceLimitsSpec = {
  readonly [K in keyof ResourceLimits]: number;
};

const LIMIT_FIELDS: readonly (keyof ResourceLimits)[] = [
  "wallTimeMs",
  "cpuTimeMs",
  "memoryBytes",
  "stdoutBytes",
  "stderrBytes",
  "combinedOutputBytes",
  "inputBytes",
  "fileSizeBytes",
  "processCount",
  "openDescriptors",
  "tempStorageBytes",
  "concurrencyPerCase",
];

/**
 * Build a validated, frozen {@link ResourceLimits} value.
 *
 * Each field MUST be a positive, finite, safe integer. Zero and negative values
 * are rejected: the sandbox limits here never legitimately permit zero (a policy
 * that permits zero, such as zero benchmark warmups, is a separate configuration
 * concern and not part of these ceilings).
 *
 * @param spec - The limit values, one per field.
 * @returns A deeply frozen {@link ResourceLimits}.
 * @throws {RangeError} If any field is missing, non-integer, or not positive.
 */
export function createResourceLimits(spec: ResourceLimitsSpec): ResourceLimits {
  for (const field of LIMIT_FIELDS) {
    const value = spec[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(
        `resource limit '${field}' must be a positive safe integer, got ${String(value)}`,
      );
    }
  }
  return Object.freeze({ ...spec });
}
