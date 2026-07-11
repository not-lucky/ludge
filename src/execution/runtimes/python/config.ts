/**
 * Configuration for the `python-uv` runtime adapter.
 *
 * The {@link PythonRuntimeConfig} captures everything the adapter needs to build
 * a concrete `uv` invocation for a target: which real `uv` and Python to launch,
 * where the shipped harness lives, the child working directory, and the values
 * that populate the sandbox's sanitized environment (`PATH`, locale,
 * `PYTHONUNBUFFERED`, and `UV_CACHE_DIR`).
 *
 * Concrete values originate at the composition root (task 11) from validated
 * configuration (task 08); this module only fixes the shape and rejects blatantly
 * malformed values so a misconfiguration surfaces early rather than as an opaque
 * spawn failure. It imports no port or domain module — it is a plain value type.
 */

/**
 * A validated, frozen configuration for one `python-uv` adapter instance.
 *
 * Every string field is required and non-empty. Paths are host-absolute
 * locations resolved by the caller; the adapter treats them as opaque and never
 * reads or evaluates the files they point at.
 */
export interface PythonRuntimeConfig {
  /** Absolute path to the real `uv` executable to launch (never a shell). */
  readonly uvPath: string;
  /** Absolute path to the Python interpreter `uv` should select via `--python`. */
  readonly pythonPath: string;
  /** Absolute path to the shipped harness entrypoint (`__main__.py`). */
  readonly harnessEntrypoint: string;
  /** Child working directory (the problem/run root the target is launched in). */
  readonly workingDirectory: string;
  /** The `PATH` value placed in the sanitized child environment. */
  readonly pathEnv: string;
  /** The locale value placed in the child environment as `LANG`. */
  readonly locale: string;
  /** The `uv` cache directory placed in the child environment as `UV_CACHE_DIR`. */
  readonly uvCacheDir: string;
  /**
   * Default entry symbol the harness invokes for `solution`/`naive` targets.
   *
   * A `ClassTrace` input names its own class, so this default only applies to
   * plain function targets; task 08 will let a problem override it per case.
   */
  readonly defaultEntrySymbol: string;
}

/** Field-by-field specification used to construct {@link PythonRuntimeConfig}. */
export type PythonRuntimeConfigSpec = {
  readonly [K in keyof PythonRuntimeConfig]: string;
};

const CONFIG_FIELDS: readonly (keyof PythonRuntimeConfig)[] = [
  "uvPath",
  "pythonPath",
  "harnessEntrypoint",
  "workingDirectory",
  "pathEnv",
  "locale",
  "uvCacheDir",
  "defaultEntrySymbol",
];

/**
 * Build a validated, frozen {@link PythonRuntimeConfig}.
 *
 * Each field MUST be a non-empty, whitespace-free-of-being-blank string. A blank
 * value almost always indicates a missing configuration binding, which would
 * otherwise become a confusing `uv` spawn error; rejecting it here fails closed
 * with a precise message.
 *
 * @param spec - The configuration values, one per field.
 * @returns A deeply frozen {@link PythonRuntimeConfig}.
 * @throws {RangeError} If any field is missing or blank.
 */
export function createPythonRuntimeConfig(
  spec: PythonRuntimeConfigSpec,
): PythonRuntimeConfig {
  for (const field of CONFIG_FIELDS) {
    const value = spec[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RangeError(
        `python runtime config '${field}' must be a non-empty string`,
      );
    }
  }
  return Object.freeze({ ...spec });
}
