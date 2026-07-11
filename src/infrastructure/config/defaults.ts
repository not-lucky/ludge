/**
 * Versioned built-in configuration defaults.
 *
 * These are the lowest tier of the precedence chain
 * (`defaults < problem.yaml < PALESTRA_* env < CLI`). Every default is explicit
 * and documented here rather than scattered as literals across the loader, so
 * the "selected versioned policy" the contract refers to has a single, auditable
 * home. Bumping {@link LIMITS_POLICY_VERSION} is how a future build changes the
 * default ceilings without silently altering existing problems.
 *
 * This module imports only the stable identifier constants it echoes (codec,
 * comparison policy, runtime) so the defaults cannot drift from the components
 * that consume them.
 */

import type { ResourceLimitsSpec } from "../../domain/index.js";
import { CODEC_VERSION } from "../../judging/codec/index.js";
import { EXACT_V1_VERSION } from "../../judging/comparator/index.js";
import { PYTHON_UV_RUNTIME_ID } from "../../execution/runtimes/python/descriptor.js";

/** The only `problem.yaml` schema version this build understands. */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Default language runtime when a problem omits `runtime`. */
export const DEFAULT_RUNTIME = PYTHON_UV_RUNTIME_ID;

/** Default input value framing when a problem omits `inputCodec`. */
export const DEFAULT_INPUT_CODEC = CODEC_VERSION;

/** Default output value framing when a problem omits `outputCodec`. */
export const DEFAULT_OUTPUT_CODEC = CODEC_VERSION;

/** Default comparison policy when a problem omits `comparisonPolicy`. */
export const DEFAULT_COMPARISON_POLICY = EXACT_V1_VERSION;

/** Default directory (relative to the problem root) holding fixed test cases. */
export const DEFAULT_CASES_DIR = "cases";

/**
 * Identifier of the versioned default-limits policy encoded by
 * {@link DEFAULT_RESOURCE_LIMITS}. A breaking change to the default ceilings
 * increments this so reports can record which policy produced a run's limits.
 */
export const LIMITS_POLICY_VERSION = "limits-v1";

/**
 * The documented default resource ceilings (policy {@link LIMITS_POLICY_VERSION}).
 *
 * A problem's `limits: {}` inherits every value; a partial `limits` map merges
 * over these. None of these ceilings may be zero — a limit of zero would forbid
 * all work. (The only place a zero is meaningful, zero benchmark warmups, is a
 * separate benchmark policy and not a resource ceiling.)
 */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimitsSpec = Object.freeze({
  /** 2 s wall-clock deadline. */
  wallTimeMs: 2_000,
  /** 2 s CPU-time deadline. */
  cpuTimeMs: 2_000,
  /** 256 MiB descendant memory ceiling. */
  memoryBytes: 268_435_456,
  /** 1 MiB bounded stdout capture. */
  stdoutBytes: 1_048_576,
  /** 1 MiB bounded stderr capture. */
  stderrBytes: 1_048_576,
  /** 2 MiB combined stdout+stderr ceiling. */
  combinedOutputBytes: 2_097_152,
  /** 4 MiB maximum request input size. */
  inputBytes: 4_194_304,
  /** 8 MiB per-file write ceiling. */
  fileSizeBytes: 8_388_608,
  /** 64 live processes. */
  processCount: 64,
  /** 256 open file descriptors. */
  openDescriptors: 256,
  /** 64 MiB run-directory temporary-storage ceiling. */
  tempStorageBytes: 67_108_864,
  /** One execution per case (no intra-case concurrency by default). */
  concurrencyPerCase: 1,
});
