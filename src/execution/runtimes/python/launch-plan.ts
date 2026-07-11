/**
 * Launch plan value type for the `python-uv` runtime.
 *
 * The {@link RuntimeAdapter} port's `buildInvocation` returns only an
 * {@link ArgvInvocation} (executable + argv). A real launch, however, also needs
 * a working directory and a sanitized environment. The {@link PythonLaunchPlan}
 * carries those alongside the invocation so the Linux sandbox (task 07) can spawn
 * the child faithfully, while `buildInvocation` continues to satisfy the port by
 * returning the plan's `invocation` field.
 *
 * This module is pure: it declares a value type only and imports a sibling port
 * type.
 */

import type { ArgvInvocation } from "../../ports/index.js";

/**
 * A complete, non-shell launch description for a Python target.
 *
 * `environment` contains ONLY the sanitized keys mandated by the sandbox
 * contract (`PATH`, `LANG`, `PYTHONUNBUFFERED`, `UV_CACHE_DIR`); no host
 * environment is inherited. `workingDirectory` is the run/problem root the child
 * starts in, so `invocation` may reference the target implementation by a
 * root-relative path.
 */
export interface PythonLaunchPlan {
  /** The direct executable + argv to spawn (never a shell string). */
  readonly invocation: ArgvInvocation;
  /** The child's working directory (the run/problem root). */
  readonly workingDirectory: string;
  /** The exact, allow-listed environment for the child process. */
  readonly environment: Readonly<Record<string, string>>;
}
