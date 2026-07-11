/**
 * Unit tests for effective-configuration precedence resolution.
 *
 * These assert the mandated ordering — built-in defaults < problem.yaml <
 * PALESTRA_* environment < CLI flags — for resource limits and global paths,
 * plus asset resolution and explicit unsafe-local handling.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_RESOURCE_LIMITS,
  loadProblemConfig,
  parseEnvOverrides,
  resolveEffectiveConfig,
} from "../../../src/infrastructure/config/index.js";
import type {
  CliOverrides,
  EnvOverrides,
  PathContext,
  ProblemConfig,
} from "../../../src/infrastructure/config/index.js";

const CONTEXT: PathContext = {
  invocationDir: "/work/invoke",
  problemRoot: "/work/problems/two-sum",
};

/** Build a problem config with an optional `memoryBytes` override in YAML. */
function problemWithMemory(memoryBytes?: number): ProblemConfig {
  const limitsBlock =
    memoryBytes === undefined ? "limits: {}" : `limits:\n  memoryBytes: ${memoryBytes}`;
  return loadProblemConfig(
    [
      "schemaVersion: 1",
      "slug: two-sum",
      "title: Two Sum",
      "entrypoint: solution.py",
      limitsBlock,
    ].join("\n"),
  );
}

const NO_ENV: EnvOverrides = { paths: {}, limits: {} };
const NO_CLI: CliOverrides = {};

describe("resolveEffectiveConfig precedence", () => {
  it("uses built-in defaults when no tier overrides", () => {
    const effective = resolveEffectiveConfig({
      problem: problemWithMemory(),
      env: NO_ENV,
      cli: NO_CLI,
      context: CONTEXT,
    });
    expect(effective.limits.memoryBytes).toBe(
      DEFAULT_RESOURCE_LIMITS.memoryBytes,
    );
  });

  it("lets problem.yaml override the default", () => {
    const effective = resolveEffectiveConfig({
      problem: problemWithMemory(1000),
      env: NO_ENV,
      cli: NO_CLI,
      context: CONTEXT,
    });
    expect(effective.limits.memoryBytes).toBe(1000);
  });

  it("lets the environment override problem.yaml", () => {
    const effective = resolveEffectiveConfig({
      problem: problemWithMemory(1000),
      env: parseEnvOverrides({ PALESTRA_MEMORY_BYTES: "2000" }),
      cli: NO_CLI,
      context: CONTEXT,
    });
    expect(effective.limits.memoryBytes).toBe(2000);
  });

  it("lets CLI flags override the environment", () => {
    const effective = resolveEffectiveConfig({
      problem: problemWithMemory(1000),
      env: parseEnvOverrides({ PALESTRA_MEMORY_BYTES: "2000" }),
      cli: { limits: { memoryBytes: 3000 } },
      context: CONTEXT,
    });
    expect(effective.limits.memoryBytes).toBe(3000);
  });

  it("leaves non-overridden limits at their default", () => {
    const effective = resolveEffectiveConfig({
      problem: problemWithMemory(1000),
      env: NO_ENV,
      cli: NO_CLI,
      context: CONTEXT,
    });
    expect(effective.limits.wallTimeMs).toBe(
      DEFAULT_RESOURCE_LIMITS.wallTimeMs,
    );
  });

  it("merges global paths with CLI winning over environment", () => {
    const effective = resolveEffectiveConfig({
      problem: problemWithMemory(),
      env: parseEnvOverrides({
        PALESTRA_UV_PATH: "/env/uv",
        PALESTRA_PYTHON_PATH: "/env/python",
      }),
      cli: { paths: { uvPath: "/cli/uv" } },
      context: CONTEXT,
    });
    expect(effective.globalPaths.uvPath).toBe("/cli/uv");
    expect(effective.globalPaths.pythonPath).toBe("/env/python");
  });

  it("resolves the entrypoint under the problem root, honoring --solution", () => {
    const base = resolveEffectiveConfig({
      problem: problemWithMemory(),
      env: NO_ENV,
      cli: NO_CLI,
      context: CONTEXT,
    });
    expect(base.assets.entrypoint).toBe(
      "/work/problems/two-sum/solution.py",
    );

    const overridden = resolveEffectiveConfig({
      problem: problemWithMemory(),
      env: NO_ENV,
      cli: { solution: "mine.py" },
      context: CONTEXT,
    });
    expect(overridden.assets.entrypoint).toBe("/work/invoke/mine.py");
  });

  it("resolves unsafe-local only from the explicit CLI flag", () => {
    const off = resolveEffectiveConfig({
      problem: problemWithMemory(),
      env: NO_ENV,
      cli: NO_CLI,
      context: CONTEXT,
    });
    expect(off.unsafeLocal).toBe(false);

    const on = resolveEffectiveConfig({
      problem: problemWithMemory(),
      env: NO_ENV,
      cli: { unsafeLocal: true },
      context: CONTEXT,
    });
    expect(on.unsafeLocal).toBe(true);
  });

  it("freezes the effective configuration", () => {
    const effective = resolveEffectiveConfig({
      problem: problemWithMemory(),
      env: NO_ENV,
      cli: NO_CLI,
      context: CONTEXT,
    });
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Object.isFrozen(effective.assets)).toBe(true);
    expect(Object.isFrozen(effective.globalPaths)).toBe(true);
  });
});
