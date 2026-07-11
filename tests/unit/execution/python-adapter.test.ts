/**
 * Unit tests for the `python-uv` runtime adapter and its configuration.
 *
 * These assert the adapter builds an exact executable + argv array (never a
 * shell string), exposes a launch plan with the run working directory and only
 * the sandbox's allow-listed environment keys, advertises the codec versions in
 * its descriptor, and that the configuration builder rejects blank fields.
 */

import { describe, it, expect } from "vitest";
import {
  createResourceLimits,
  initialGeneration,
  toCaseId,
  toRunId,
} from "../../../src/domain/index.js";
import type {
  ExecutionRequest,
  ImplementationRole,
} from "../../../src/domain/index.js";
import { CODEC_VERSION } from "../../../src/judging/codec/index.js";
import {
  createPythonRuntimeAdapter,
  createPythonRuntimeConfig,
  PYTHON_UV_RUNTIME_ID,
} from "../../../src/execution/runtimes/python/index.js";
import type { PythonRuntimeConfigSpec } from "../../../src/execution/runtimes/python/index.js";

/** A complete, valid configuration spec with distinguishable field values. */
const CONFIG_SPEC: PythonRuntimeConfigSpec = {
  uvPath: "/opt/uv/bin/uv",
  pythonPath: "/opt/python/3.14/bin/python3",
  harnessEntrypoint: "/srv/harness/__main__.py",
  workingDirectory: "/run/problem-root",
  pathEnv: "/usr/bin:/bin",
  locale: "C.UTF-8",
  uvCacheDir: "/run/uv-cache",
  defaultEntrySymbol: "solve",
};

/** Build an execution request naming an implementation with the given role. */
function makeRequest(
  role: ImplementationRole,
  relativePath: string,
): ExecutionRequest {
  return {
    runId: toRunId("run-1"),
    caseId: toCaseId("case-1"),
    problemFingerprint: "problem-abc",
    implementation: { role, relativePath },
    inputBytes: new Uint8Array(),
    inputCodecVersion: CODEC_VERSION,
    outputCodecVersion: CODEC_VERSION,
    limits: createResourceLimits({
      wallTimeMs: 1000,
      cpuTimeMs: 1000,
      memoryBytes: 256 * 1024 * 1024,
      stdoutBytes: 1024,
      stderrBytes: 1024,
      combinedOutputBytes: 2048,
      inputBytes: 1024,
      fileSizeBytes: 1024,
      processCount: 8,
      openDescriptors: 64,
      tempStorageBytes: 1024 * 1024,
      concurrencyPerCase: 1,
    }),
    generation: initialGeneration(),
  };
}

describe("createPythonRuntimeConfig", () => {
  it("freezes a fully specified configuration", () => {
    const config = createPythonRuntimeConfig(CONFIG_SPEC);
    expect(config).toEqual(CONFIG_SPEC);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects an empty string field", () => {
    expect(() =>
      createPythonRuntimeConfig({ ...CONFIG_SPEC, uvPath: "" }),
    ).toThrow(RangeError);
  });

  it("rejects a blank (whitespace-only) field", () => {
    expect(() =>
      createPythonRuntimeConfig({ ...CONFIG_SPEC, defaultEntrySymbol: "   " }),
    ).toThrow(RangeError);
  });
});

describe("createPythonRuntimeAdapter", () => {
  const config = createPythonRuntimeConfig(CONFIG_SPEC);
  const adapter = createPythonRuntimeAdapter("python-backend", config);

  it("describe() advertises the python-uv identity and codec versions", () => {
    const descriptor = adapter.describe();
    expect(descriptor.id).toBe(PYTHON_UV_RUNTIME_ID);
    expect(descriptor.inputCodecVersion).toBe(CODEC_VERSION);
    expect(descriptor.outputCodecVersion).toBe(CODEC_VERSION);
  });

  it("is branded with its backend id", () => {
    expect(adapter.backendId).toBe("python-backend");
  });

  it("buildInvocation() yields an exact executable + argv, never a shell string", () => {
    const invocation = adapter.buildInvocation(
      makeRequest("solution", "solutions/main.py"),
    );
    expect(invocation.executable).toBe(config.uvPath);
    expect(invocation.args).toEqual([
      "run",
      "--no-project",
      "--python",
      config.pythonPath,
      config.harnessEntrypoint,
      "--role",
      "solution",
      "--impl",
      "solutions/main.py",
      "--entry",
      config.defaultEntrySymbol,
    ]);
  });

  it("threads the implementation role and path through argv verbatim", () => {
    const invocation = adapter.buildInvocation(
      makeRequest("generator", "gen/seed.py"),
    );
    expect(invocation.args).toContain("generator");
    expect(invocation.args).toContain("gen/seed.py");
  });

  it("buildLaunchPlan() carries the working directory and only allow-listed env keys", () => {
    const plan = adapter.buildLaunchPlan(
      makeRequest("naive", "naive/ref.py"),
    );
    expect(plan.workingDirectory).toBe(config.workingDirectory);
    expect(Object.keys(plan.environment).sort()).toEqual([
      "LANG",
      "PATH",
      "PYTHONUNBUFFERED",
      "UV_CACHE_DIR",
    ]);
    expect(plan.environment).toEqual({
      PATH: config.pathEnv,
      LANG: config.locale,
      PYTHONUNBUFFERED: "1",
      UV_CACHE_DIR: config.uvCacheDir,
    });
  });

  it("buildLaunchPlan() reuses the same invocation as buildInvocation()", () => {
    const request = makeRequest("solution", "solutions/main.py");
    expect(adapter.buildLaunchPlan(request).invocation).toEqual(
      adapter.buildInvocation(request),
    );
  });
});
