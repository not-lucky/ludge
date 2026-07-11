/**
 * The `python-uv` runtime adapter.
 *
 * This adapter turns an immutable {@link ExecutionRequest} into the exact `uv`
 * invocation that launches the shipped Python harness against a target
 * implementation:
 *
 * ```text
 * uv run --no-project --python <python> <harness> \
 *   --role <role> --impl <relativePath> --entry <entrySymbol>
 * ```
 *
 * The invocation is always an executable plus a verbatim argv array — never a
 * shell string — so there is no shell to perform word-splitting or command
 * substitution, and the adapter never reads or evaluates the target script; it
 * only names it. The request envelope and the sanitized environment are left
 * untouched: the target implementation and its role travel as explicit argv
 * arguments the harness parses.
 *
 * Beyond the port's {@link ArgvInvocation}, a launch also needs a working
 * directory and a sanitized environment. {@link PythonRuntimeAdapter.buildLaunchPlan}
 * provides those in a {@link PythonLaunchPlan}, while `buildInvocation` returns
 * just the invocation to honor the {@link RuntimeAdapter} port.
 */

import type { ExecutionRequest } from "../../../domain/index.js";
import type {
  ArgvInvocation,
  RuntimeAdapter,
  RuntimeDescriptor,
} from "../../ports/index.js";
import type { PythonRuntimeConfig } from "./config.js";
import type { PythonLaunchPlan } from "./launch-plan.js";
import { pythonUvDescriptor } from "./descriptor.js";

/**
 * A {@link RuntimeAdapter} for Python targets launched through `uv`, extended
 * with {@link buildLaunchPlan} for the working directory and sanitized
 * environment that the port's {@link ArgvInvocation} cannot carry.
 *
 * @typeParam Tag - The owning backend's coherence tag.
 */
export interface PythonRuntimeAdapter<Tag extends string = string>
  extends RuntimeAdapter<Tag> {
  /**
   * Build the full launch plan (invocation + working directory + environment).
   *
   * @param request - The immutable execution request.
   * @returns The complete, non-shell {@link PythonLaunchPlan}.
   */
  buildLaunchPlan(request: ExecutionRequest): PythonLaunchPlan;
}

/**
 * Create a `python-uv` {@link RuntimeAdapter} bound to a backend coherence tag.
 *
 * @typeParam Tag - The owning backend's coherence tag.
 * @param backendId - The backend this adapter belongs to.
 * @param config - The validated runtime configuration.
 * @returns A {@link PythonRuntimeAdapter} branded with `backendId`.
 */
export function createPythonRuntimeAdapter<Tag extends string>(
  backendId: Tag,
  config: PythonRuntimeConfig,
): PythonRuntimeAdapter<Tag> {
  const buildInvocation = (request: ExecutionRequest): ArgvInvocation => ({
    executable: config.uvPath,
    args: [
      "run",
      "--no-project",
      "--python",
      config.pythonPath,
      config.harnessEntrypoint,
      "--role",
      request.implementation.role,
      "--impl",
      request.implementation.relativePath,
      "--entry",
      config.defaultEntrySymbol,
    ],
  });

  return {
    backendId,

    describe(): RuntimeDescriptor {
      return pythonUvDescriptor();
    },

    buildInvocation,

    buildLaunchPlan(request: ExecutionRequest): PythonLaunchPlan {
      return {
        invocation: buildInvocation(request),
        workingDirectory: config.workingDirectory,
        // Only the sanitized keys mandated by the sandbox contract are set; no
        // host environment is inherited. PYTHONUNBUFFERED keeps the single
        // request/response line from being withheld in a stdio buffer.
        environment: {
          PATH: config.pathEnv,
          LANG: config.locale,
          PYTHONUNBUFFERED: "1",
          UV_CACHE_DIR: config.uvCacheDir,
        },
      };
    },
  };
}
