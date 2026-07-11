/**
 * Configuration prerequisite validator.
 *
 * Before any target is executed, the resolved {@link EffectiveConfig} is checked
 * against the host: the configured *real* `uv` and Python must be present, the
 * runtime/codec/comparison-policy must be supported by this build, every
 * referenced asset must exist, the resource limits must be representable, and —
 * outside unsafe-local mode — the required sandbox controls must be available.
 * Production never substitutes a fake runtime, so a missing `uv` is a hard
 * failure, not a fallback.
 *
 * Host interactions (filesystem existence, control availability) are reached
 * through an injected {@link ConfigProbes} so the validator stays deterministic
 * under test and decoupled from the concrete Linux sandbox adapter; the
 * composition root (task 11) supplies the real probes. Every failure is
 * collected so a caller sees the complete picture at once.
 */

import type { ControlId } from "../../execution/sandbox/linux/controls/ids.js";
import { isSupportedCodecVersion } from "../../judging/codec/index.js";
import { isSupportedPolicyVersion } from "../../judging/comparator/index.js";
import { ConfigValidationError } from "./errors.js";
import type { EffectiveConfig } from "./precedence.js";

/**
 * Host probes the validator depends on. Each is async and side-effect-free with
 * respect to configuration; a fake implementation makes unit tests fully
 * deterministic.
 */
export interface ConfigProbes {
  /**
   * Whether a path exists and is executable (used for `uv` and Python).
   *
   * @param path - Absolute path to probe.
   */
  isExecutable(path: string): Promise<boolean>;
  /**
   * Whether a filesystem entry exists (used for referenced assets).
   *
   * @param path - Absolute path to probe.
   */
  exists(path: string): Promise<boolean>;
  /**
   * The set of sandbox controls this host can actually install.
   *
   * @returns The available control identifiers.
   */
  availableControls(): Promise<ReadonlySet<ControlId>>;
}

/** The inputs to {@link validateConfiguration}. */
export interface ValidationRequest {
  /** The resolved configuration to validate. */
  readonly effective: EffectiveConfig;
  /** Host probes for filesystem and control availability. */
  readonly probes: ConfigProbes;
  /** Runtime identifiers this build can launch (e.g. `{"python-uv"}`). */
  readonly supportedRuntimes: ReadonlySet<string>;
  /** Controls that must be installable unless unsafe-local mode is active. */
  readonly requiredControls: readonly ControlId[];
}

/** The outcome of validation: success, or an ordered list of failures. */
export type ValidationReport =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly string[] };

/**
 * Validate a resolved configuration against the host.
 *
 * @param request - The effective config, probes, and supported-capability sets.
 * @returns A report that is `ok` when every prerequisite holds, or carries the
 *   ordered failure messages otherwise.
 */
export async function validateConfiguration(
  request: ValidationRequest,
): Promise<ValidationReport> {
  const { effective, probes, supportedRuntimes, requiredControls } = request;
  const failures: string[] = [];

  await checkExecutables(effective, probes, failures);
  checkSupportedComponents(effective, supportedRuntimes, failures);
  await checkAssets(effective, probes, failures);
  checkLimitsRepresentable(effective, failures);
  await checkControls(effective, probes, requiredControls, failures);

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * Validate a resolved configuration, throwing on failure.
 *
 * @param request - The validation request.
 * @throws {ConfigValidationError} If any prerequisite fails.
 */
export async function assertConfigurationValid(
  request: ValidationRequest,
): Promise<void> {
  const report = await validateConfiguration(request);
  if (!report.ok) {
    throw new ConfigValidationError(report.failures);
  }
}

/** Check that the configured `uv` and Python exist and are executable. */
async function checkExecutables(
  effective: EffectiveConfig,
  probes: ConfigProbes,
  failures: string[],
): Promise<void> {
  const { uvPath, pythonPath } = effective.globalPaths;

  if (uvPath === undefined) {
    failures.push("configured uv path is not set (PALESTRA_UV_PATH)");
  } else if (!(await probes.isExecutable(uvPath))) {
    failures.push(`configured uv is not an executable file: ${uvPath}`);
  }

  if (pythonPath === undefined) {
    failures.push("configured Python path is not set (PALESTRA_PYTHON_PATH)");
  } else if (!(await probes.isExecutable(pythonPath))) {
    failures.push(`configured Python is not an executable file: ${pythonPath}`);
  }
}

/** Check the runtime, codecs, and comparison policy are supported. */
function checkSupportedComponents(
  effective: EffectiveConfig,
  supportedRuntimes: ReadonlySet<string>,
  failures: string[],
): void {
  const { runtime, inputCodec, outputCodec, comparisonPolicy } =
    effective.problem;

  if (!supportedRuntimes.has(runtime)) {
    failures.push(`unsupported runtime: ${runtime}`);
  }
  if (!isSupportedCodecVersion(inputCodec)) {
    failures.push(`unsupported input codec: ${inputCodec}`);
  }
  if (!isSupportedCodecVersion(outputCodec)) {
    failures.push(`unsupported output codec: ${outputCodec}`);
  }
  if (!isSupportedPolicyVersion(comparisonPolicy)) {
    failures.push(`unsupported comparison policy: ${comparisonPolicy}`);
  }
}

/** Check that every referenced asset exists on disk. */
async function checkAssets(
  effective: EffectiveConfig,
  probes: ConfigProbes,
  failures: string[],
): Promise<void> {
  const { entrypoint, casesDir, generator, naive } = effective.assets;

  const checks: readonly (readonly [string, string])[] = [
    ["entrypoint", entrypoint],
    ["cases directory", casesDir],
    ...(generator === undefined ? [] : [["generator", generator] as const]),
    ...(naive === undefined ? [] : [["naive", naive] as const]),
  ];

  for (const [label, path] of checks) {
    if (!(await probes.exists(path))) {
      failures.push(`${label} does not exist: ${path}`);
    }
  }
}

/** Check that every resolved limit is a representable positive integer. */
function checkLimitsRepresentable(
  effective: EffectiveConfig,
  failures: string[],
): void {
  for (const [field, value] of Object.entries(effective.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      failures.push(
        `resource limit '${field}' is not representable: ${String(value)}`,
      );
    }
  }
}

/**
 * Check that the required sandbox controls are available.
 *
 * Skipped entirely in unsafe-local mode: the user has explicitly opted out of
 * enforcement, so a missing control is expected and every result is separately
 * labeled `sandbox_unsupported`.
 */
async function checkControls(
  effective: EffectiveConfig,
  probes: ConfigProbes,
  requiredControls: readonly ControlId[],
  failures: string[],
): Promise<void> {
  if (effective.unsafeLocal) {
    return;
  }
  const available = await probes.availableControls();
  for (const control of requiredControls) {
    if (!available.has(control)) {
      failures.push(`required sandbox control '${control}' is unavailable`);
    }
  }
}
