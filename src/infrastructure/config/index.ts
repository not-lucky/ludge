/**
 * Public surface of the configuration infrastructure.
 *
 * The composition root (task 11) imports from here to load a `problem.yaml`,
 * resolve the effective configuration across the precedence chain, and validate
 * host prerequisites before execution. Internal helpers (the YAML reader's line
 * tokenizer, individual field parsers) are not re-exported: callers depend on
 * the loader, resolver, and validator surfaces, not on parsing internals.
 */

// Errors and exit-code mapping.
export {
  CONFIG_EXIT_CODE,
  ConfigError,
  ConfigValidationError,
  PathResolutionError,
  ProblemConfigError,
} from "./errors.js";

// YAML subset parser.
export { parseYaml, YAML_MAX_DEPTH } from "./yaml.js";
export type { YamlNode, YamlParseError, YamlParseResult } from "./yaml.js";

// Slug validation.
export { assertValidSlug, isValidSlug, MAX_SLUG_LENGTH } from "./slug.js";

// Safe path resolution.
export {
  assertNoNulByte,
  resolveInvocationPath,
  resolveOverridablePath,
  resolveProblemLocalPath,
} from "./paths.js";
export type { OverridablePath, PathContext } from "./paths.js";

// Versioned built-in defaults.
export {
  DEFAULT_CASES_DIR,
  DEFAULT_COMPARISON_POLICY,
  DEFAULT_INPUT_CODEC,
  DEFAULT_OUTPUT_CODEC,
  DEFAULT_RESOURCE_LIMITS,
  DEFAULT_RUNTIME,
  LIMITS_POLICY_VERSION,
  SUPPORTED_SCHEMA_VERSION,
} from "./defaults.js";

// problem.yaml schema v1 loader.
export { loadProblemConfig, parseProblemConfig } from "./problem-config.js";
export type { ProblemConfig, ProblemLimitOverrides } from "./problem-config.js";

// PALESTRA_* environment overrides.
export { parseEnvOverrides } from "./env.js";
export type { EnvironmentRecord, EnvOverrides, GlobalPaths } from "./env.js";

// Effective-configuration resolution.
export { resolveEffectiveConfig } from "./precedence.js";
export type {
  CliOverrides,
  EffectiveConfig,
  ResolveInput,
  ResolvedAssets,
} from "./precedence.js";

// Unsafe-local policy.
export {
  labelForUnsafeLocal,
  resolveUnsafeLocal,
  SANDBOX_UNSUPPORTED_LABEL,
} from "./unsafe-local.js";

// Prerequisite validator.
export { assertConfigurationValid, validateConfiguration } from "./validator.js";
export type {
  ConfigProbes,
  ValidationReport,
  ValidationRequest,
} from "./validator.js";
