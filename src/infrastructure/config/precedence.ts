/**
 * Effective-configuration resolution through the precedence chain.
 *
 * This is where the four configuration tiers collapse into one frozen
 * {@link EffectiveConfig}, in the exact order the contract mandates:
 *
 * ```text
 * built-in defaults < problem.yaml < PALESTRA_* environment < CLI flags
 * ```
 *
 * Resource limits are merged field-by-field across the tiers and validated once
 * through the domain's {@link createResourceLimits}; global paths are merged from
 * environment then CLI; problem-local asset paths are resolved and confined to
 * the problem root (with a CLI option overriding a problem-local default); and
 * `--unsafe-local` is resolved as an explicit flag only.
 *
 * This is infrastructure: it composes the config value types and the path
 * helpers, and imports no CLI or application module.
 */

import {
  createResourceLimits,
  type ResourceLimits,
  type ResourceLimitsSpec,
} from "../../domain/index.js";
import { ConfigError } from "./errors.js";
import { DEFAULT_RESOURCE_LIMITS, LIMITS_POLICY_VERSION } from "./defaults.js";
import type { EnvOverrides, GlobalPaths } from "./env.js";
import type { ProblemConfig, ProblemLimitOverrides } from "./problem-config.js";
import {
  resolveInvocationPath,
  resolveOverridablePath,
  resolveProblemLocalPath,
  type PathContext,
} from "./paths.js";
import { resolveUnsafeLocal } from "./unsafe-local.js";

/** Overrides supplied by parsed CLI flags (the highest-precedence tier). */
export interface CliOverrides {
  /** Whether `--unsafe-local` was passed (explicit only). */
  readonly unsafeLocal?: boolean;
  /** Resource-limit overrides from CLI flags. */
  readonly limits?: ProblemLimitOverrides;
  /** Global-path overrides from CLI flags. */
  readonly paths?: Partial<GlobalPaths>;
  /** `--solution <path>`: overrides the target entrypoint. */
  readonly solution?: string;
  /** `--generator <path>`: overrides the problem's generator. */
  readonly generator?: string;
  /** `--naive <path>`: overrides the problem's naive/reference script. */
  readonly naive?: string;
}

/** Absolute, resolved paths to the assets a run references. */
export interface ResolvedAssets {
  /** Absolute path to the target entrypoint (post CLI override). */
  readonly entrypoint: string;
  /** Absolute path to the test-case directory. */
  readonly casesDir: string;
  /** Absolute path to the generator, when the problem or CLI provides one. */
  readonly generator?: string;
  /** Absolute path to the naive/reference script, when provided. */
  readonly naive?: string;
}

/** The fully-resolved configuration a command executes against. */
export interface EffectiveConfig {
  /** Absolute real problem root used for runtime working-directory confinement. */
  readonly problemRoot: string;
  /** The validated problem configuration this run targets. */
  readonly problem: ProblemConfig;
  /** The single, validated resource-limit set after all tiers merge. */
  readonly limits: ResourceLimits;
  /** Version of the default-limits policy the ceilings derive from. */
  readonly limitsPolicyVersion: string;
  /** Merged global paths (any subset present; validated for use later). */
  readonly globalPaths: Partial<GlobalPaths>;
  /** Resolved, root-confined asset paths. */
  readonly assets: ResolvedAssets;
  /** Whether unsafe-local mode is active (explicit CLI flag only). */
  readonly unsafeLocal: boolean;
}

/** The inputs to {@link resolveEffectiveConfig}, one per precedence tier. */
export interface ResolveInput {
  /** The validated `problem.yaml` (tier 2). */
  readonly problem: ProblemConfig;
  /** Reserved `PALESTRA_*` overrides (tier 3). */
  readonly env: EnvOverrides;
  /** Parsed CLI-flag overrides (tier 4). */
  readonly cli: CliOverrides;
  /** The roots used to resolve and confine relative paths. */
  readonly context: PathContext;
}

/**
 * Resolve the four configuration tiers into one frozen {@link EffectiveConfig}.
 *
 * @param input - The problem config, env overrides, CLI overrides, and roots.
 * @returns The immutable effective configuration.
 * @throws {ConfigError} If the merged resource limits are not representable.
 * @throws {PathResolutionError} If an asset path is unsafe or escapes the root.
 */
export function resolveEffectiveConfig(input: ResolveInput): EffectiveConfig {
  const { problem, env, cli, context } = input;

  const limits = resolveLimits(problem.limits, env.limits, cli.limits);
  const globalPaths: Partial<GlobalPaths> = {
    ...env.paths,
    ...(cli.paths ?? {}),
  };
  const assets = resolveAssets(problem, cli, context);
  const unsafeLocal = resolveUnsafeLocal(cli.unsafeLocal ?? false);

  return Object.freeze({
    problemRoot: context.problemRoot,
    problem,
    limits,
    limitsPolicyVersion: LIMITS_POLICY_VERSION,
    globalPaths: Object.freeze(globalPaths),
    assets: Object.freeze(assets),
    unsafeLocal,
  });
}

/**
 * Merge resource-limit overrides across tiers, then validate once.
 *
 * Defaults are the base; each later tier's present keys win. The fully-merged
 * spec is handed to {@link createResourceLimits}, which enforces that every
 * field is a positive, representable integer; any violation is surfaced as a
 * configuration error (exit code 3).
 */
function resolveLimits(
  problemLimits: ProblemLimitOverrides,
  envLimits: ProblemLimitOverrides,
  cliLimits: ProblemLimitOverrides | undefined,
): ResourceLimits {
  const merged: ResourceLimitsSpec = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...problemLimits,
    ...envLimits,
    ...(cliLimits ?? {}),
  };
  try {
    return createResourceLimits(merged);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`invalid resolved resource limits: ${detail}`);
  }
}

/**
 * Resolve the problem's asset paths to absolute, root-confined locations,
 * honoring CLI overrides where the contract allows them.
 */
function resolveAssets(
  problem: ProblemConfig,
  cli: CliOverrides,
  context: PathContext,
): ResolvedAssets {
  const assets: {
    entrypoint: string;
    casesDir: string;
    generator?: string;
    naive?: string;
  } = {
    entrypoint: resolveOverridablePath(context, {
      cliOverride: cli.solution,
      problemLocalDefault: problem.entrypoint,
    }),
    casesDir: resolveProblemLocalPath(context, problem.casesDir),
  };

  const generator = resolveOptionalScript(
    context,
    cli.generator,
    problem.generator,
  );
  if (generator !== undefined) {
    assets.generator = generator;
  }
  const naive = resolveOptionalScript(context, cli.naive, problem.naive);
  if (naive !== undefined) {
    assets.naive = naive;
  }

  return assets;
}

/**
 * Resolve an optional script path: a CLI override (against the invocation dir)
 * wins; otherwise a problem-local default is confined to the root; if neither is
 * present the script is absent.
 */
function resolveOptionalScript(
  context: PathContext,
  cliOverride: string | undefined,
  problemLocalDefault: string | undefined,
): string | undefined {
  if (cliOverride !== undefined) {
    return resolveInvocationPath(context, cliOverride);
  }
  if (problemLocalDefault !== undefined) {
    return resolveProblemLocalPath(context, problemLocalDefault);
  }
  return undefined;
}
