/**
 * Configuration error hierarchy.
 *
 * Every failure raised while loading, resolving, or validating configuration is
 * a {@link ConfigError}. Per the CLI contract, malformed user/config/problem
 * data maps to process exit code `3`, so each error carries that code on
 * `exitCode` — the CLI layer (task 11) reads it rather than re-deriving a code
 * from the message. The subclasses distinguish the seam that failed
 * (`problem.yaml` parse/schema, unsafe path resolution, or the prerequisite
 * validator) so callers and reports can react precisely.
 *
 * Parsers in this layer (for example the YAML reader) return result unions and
 * never throw for malformed *input*; these error classes are thrown only at the
 * higher-level seams where a structured failure is the natural control flow.
 *
 * These subclass the ECMAScript built-in {@link Error} only, matching the
 * error-class style used across the codebase.
 */

/** The exit code the CLI contract assigns to invalid user/config/problem data. */
export const CONFIG_EXIT_CODE = 3;

/** Base class for every configuration-layer error. */
export class ConfigError extends Error {
  /** The process exit code this error maps to (always {@link CONFIG_EXIT_CODE}). */
  public readonly exitCode: number = CONFIG_EXIT_CODE;

  /**
   * @param message - Human-readable, bounded description of the failure.
   */
  public constructor(message: string) {
    super(message);
    // Restore the prototype chain across the Error super() call so that
    // `instanceof` works when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Raised when `problem.yaml` cannot be parsed or fails schema v1 validation:
 * a malformed document, an unknown field, a wrong value type, a duplicate key,
 * a malformed slug, or an out-of-range limit.
 */
export class ProblemConfigError extends ConfigError {
  /**
   * @param message - What was wrong with the problem configuration.
   * @param field - Optional dotted field path the failure is anchored to
   *   (for example `"limits.memoryBytes"`), aiding precise diagnostics.
   */
  public constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(field === undefined ? message : `${field}: ${message}`);
  }
}

/**
 * Raised when a path cannot be resolved safely: it contains a NUL byte, or it
 * escapes the problem root it was declared relative to. Resolving such a path is
 * a fail-closed error rather than a silently clamped value.
 */
export class PathResolutionError extends ConfigError {
  /**
   * @param message - Why the path could not be resolved.
   * @param offendingPath - The raw path that triggered the failure.
   */
  public constructor(
    message: string,
    public readonly offendingPath: string,
  ) {
    super(`${message}: ${JSON.stringify(offendingPath)}`);
  }
}

/**
 * Raised when the prerequisite validator finds the resolved configuration
 * unusable: the configured `uv` is absent, the runtime/codec/policy is
 * unsupported, a referenced asset is missing, a limit is not representable, or a
 * required sandbox control is unavailable. It aggregates every failure so a
 * caller sees the complete picture in one error.
 */
export class ConfigValidationError extends ConfigError {
  /**
   * @param failures - The ordered, non-empty list of validation failure
   *   messages, most important first.
   */
  public constructor(public readonly failures: readonly string[]) {
    super(
      `configuration validation failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
}
