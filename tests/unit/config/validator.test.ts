/**
 * Unit tests for the configuration prerequisite validator.
 *
 * These drive the validator with a deterministic fake {@link ConfigProbes} and
 * assert the required failure paths — missing `uv`, missing script, unsupported
 * runtime, unavailable control — plus the unsafe-local rule that skips control
 * checks (enforcement is intentionally bypassed) while never being a normal
 * pass elsewhere in the pipeline.
 */

import { describe, it, expect } from "vitest";
import {
  loadProblemConfig,
  parseEnvOverrides,
  resolveEffectiveConfig,
  validateConfiguration,
} from "../../../src/infrastructure/config/index.js";
import type {
  CliOverrides,
  ConfigProbes,
  EffectiveConfig,
} from "../../../src/infrastructure/config/index.js";
import type { ControlId } from "../../../src/execution/sandbox/linux/controls/ids.js";

const CONTEXT = {
  invocationDir: "/work/invoke",
  problemRoot: "/work/problems/two-sum",
};

const UV = "/bin/uv";
const PYTHON = "/bin/python";
const ENTRYPOINT = "/work/problems/two-sum/solution.py";
const CASES = "/work/problems/two-sum/cases";

const SUPPORTED_RUNTIMES: ReadonlySet<string> = new Set(["python-uv"]);
const REQUIRED_CONTROLS: readonly ControlId[] = ["cgroup"];

/** Build an effective config, optionally without configured executables. */
function makeEffective(
  cli: CliOverrides = {},
  withExecutables = true,
): EffectiveConfig {
  const problem = loadProblemConfig(
    [
      "schemaVersion: 1",
      "slug: two-sum",
      "title: Two Sum",
      "entrypoint: solution.py",
      "limits: {}",
    ].join("\n"),
  );
  const env = withExecutables
    ? parseEnvOverrides({ PALESTRA_UV_PATH: UV, PALESTRA_PYTHON_PATH: PYTHON })
    : parseEnvOverrides({});
  return resolveEffectiveConfig({ problem, env, cli, context: CONTEXT });
}

/** A deterministic fake probe set. */
function makeProbes(opts: {
  executables?: ReadonlySet<string>;
  existing?: ReadonlySet<string>;
  controls?: ReadonlySet<ControlId>;
}): ConfigProbes {
  const executables = opts.executables ?? new Set<string>();
  const existing = opts.existing ?? new Set<string>();
  const controls = opts.controls ?? new Set<ControlId>();
  return {
    isExecutable: (path) => Promise.resolve(executables.has(path)),
    exists: (path) => Promise.resolve(existing.has(path)),
    availableControls: () => Promise.resolve(controls),
  };
}

/** A probe set where every prerequisite is satisfied. */
function healthyProbes(): ConfigProbes {
  return makeProbes({
    executables: new Set([UV, PYTHON]),
    existing: new Set([ENTRYPOINT, CASES]),
    controls: new Set<ControlId>(["cgroup"]),
  });
}

describe("validateConfiguration", () => {
  it("passes when every prerequisite holds", async () => {
    const report = await validateConfiguration({
      effective: makeEffective(),
      probes: healthyProbes(),
      supportedRuntimes: SUPPORTED_RUNTIMES,
      requiredControls: REQUIRED_CONTROLS,
    });
    expect(report.ok).toBe(true);
  });

  it("fails when uv is not configured", async () => {
    const report = await validateConfiguration({
      effective: makeEffective({}, false),
      probes: healthyProbes(),
      supportedRuntimes: SUPPORTED_RUNTIMES,
      requiredControls: REQUIRED_CONTROLS,
    });
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.failures.join("\n")).toMatch(/uv path is not set/u);
  });

  it("fails when the configured uv is not executable", async () => {
    const report = await validateConfiguration({
      effective: makeEffective(),
      probes: makeProbes({
        executables: new Set([PYTHON]),
        existing: new Set([ENTRYPOINT, CASES]),
        controls: new Set<ControlId>(["cgroup"]),
      }),
      supportedRuntimes: SUPPORTED_RUNTIMES,
      requiredControls: REQUIRED_CONTROLS,
    });
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.failures.join("\n")).toMatch(/uv is not an executable/u);
  });

  it("fails when a referenced script is missing", async () => {
    const report = await validateConfiguration({
      effective: makeEffective(),
      probes: makeProbes({
        executables: new Set([UV, PYTHON]),
        existing: new Set([CASES]),
        controls: new Set<ControlId>(["cgroup"]),
      }),
      supportedRuntimes: SUPPORTED_RUNTIMES,
      requiredControls: REQUIRED_CONTROLS,
    });
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.failures.join("\n")).toMatch(/entrypoint does not exist/u);
  });

  it("fails when the runtime is unsupported", async () => {
    const report = await validateConfiguration({
      effective: makeEffective(),
      probes: healthyProbes(),
      supportedRuntimes: new Set(["node-vm"]),
      requiredControls: REQUIRED_CONTROLS,
    });
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.failures.join("\n")).toMatch(/unsupported runtime/u);
  });

  it("fails when a required control is unavailable", async () => {
    const report = await validateConfiguration({
      effective: makeEffective(),
      probes: makeProbes({
        executables: new Set([UV, PYTHON]),
        existing: new Set([ENTRYPOINT, CASES]),
        controls: new Set<ControlId>(),
      }),
      supportedRuntimes: SUPPORTED_RUNTIMES,
      requiredControls: REQUIRED_CONTROLS,
    });
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.failures.join("\n")).toMatch(
      /required sandbox control 'cgroup' is unavailable/u,
    );
  });

  it("skips control checks in explicit unsafe-local mode", async () => {
    const report = await validateConfiguration({
      effective: makeEffective({ unsafeLocal: true }),
      probes: makeProbes({
        executables: new Set([UV, PYTHON]),
        existing: new Set([ENTRYPOINT, CASES]),
        controls: new Set<ControlId>(),
      }),
      supportedRuntimes: SUPPORTED_RUNTIMES,
      requiredControls: REQUIRED_CONTROLS,
    });
    expect(report.ok).toBe(true);
  });
});
