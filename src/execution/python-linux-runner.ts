/** Concrete Python/uv + Linux sandbox runner. No plug-in registry is involved. */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionRequest } from "../domain/execution.js";
import type { RunContext } from "../infrastructure/problem.js";
import { createExecutionProfiler } from "../telemetry/profile.js";
import {
  createLinuxSandbox,
  type LinuxSandboxConfig,
} from "./linux-sandbox.js";
import type { Runner } from "./runner.js";

const clock = {
  monotonicNs: (): bigint => process.hrtime.bigint(),
  wallTimeUtc: (): string => new Date().toISOString(),
};

/** Create the only runner Palestra currently ships. */
export function createPythonLinuxRunner(
  context: RunContext,
  benchmarkCpuWeight?: number,
): Runner {
  return createRunner(
    context.problemRoot,
    context.stateDirectory,
    context.cgroupParentPath,
    context.uvPath,
    context.pythonPath,
    benchmarkCpuWeight,
    context.unsafeLocal,
  );
}

function createRunner(
  problemRoot: string,
  stateDirectory: string,
  cgroupParentPath: string,
  uvPath: string,
  pythonPath: string,
  benchmarkCpuWeight: number | undefined,
  unsafeLocal: boolean,
): Runner {
  const harnessEntrypoint = join(
    dirname(fileURLToPath(import.meta.url)),
    "runtimes",
    "python",
    "harness",
    "__main__.py",
  );
  const cache = resolve(stateDirectory, "uv-cache");
  const config: LinuxSandboxConfig = {
    workingDirectory: problemRoot,
    environment: {
      PATH: dirname(uvPath),
      LANG: "C.UTF-8",
      PYTHONUNBUFFERED: "1",
      UV_CACHE_DIR: cache,
    },
    cgroupParentPath,
    tempBaseDir: resolve(stateDirectory, "tmp"),
    sigtermGraceMs: 100,
    unsafeLocal,
    ...(benchmarkCpuWeight === undefined ? {} : { benchmarkCpuWeight }),
    clock,
  };
  const sandbox = createLinuxSandbox(config);
  const profiler = createExecutionProfiler(clock);

  return {
    run(request: ExecutionRequest, input, cancellation) {
      return sandbox.run(
        {
          executable: uvPath,
          args: [
            "run",
            "--no-project",
            "--python",
            pythonPath,
            harnessEntrypoint,
            "--role",
            request.implementation.role,
            "--impl",
            request.implementation.relativePath,
            "--entry",
            "solution",
          ],
        },
        input,
        request.limits,
        cancellation,
      );
    },
    beginProfile() {
      return profiler.begin();
    },
  };
}
