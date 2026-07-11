/**
 * Unit tests for the Linux sandbox configuration builder.
 *
 * These assert that {@link createLinuxSandboxConfig} freezes a fully specified
 * config, applies the documented defaults, defensively copies the mutable
 * collections, and rejects blank/relative path fields and non-positive grace
 * windows.
 */

import { describe, it, expect } from "vitest";
import {
  createLinuxSandboxConfig,
  DEFAULT_REQUIRED_CONTROLS,
  DEFAULT_SIGTERM_GRACE_MS,
} from "../../../src/execution/sandbox/linux/index.js";
import type { LinuxSandboxConfigSpec } from "../../../src/execution/sandbox/linux/index.js";

/** A complete, valid spec with distinguishable field values. */
const SPEC: LinuxSandboxConfigSpec = {
  workingDirectory: "/run/problem-root",
  environment: {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    UV_CACHE_DIR: "/run/uv-cache",
  },
  readonlyPaths: ["/srv/problem", "/opt/python"],
  cgroupParentPath: "/sys/fs/cgroup/palestra",
  tempBaseDir: "/run/palestra-tmp",
};

describe("createLinuxSandboxConfig", () => {
  it("freezes a fully specified configuration and applies defaults", () => {
    const config = createLinuxSandboxConfig(SPEC);
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.sigtermGraceMs).toBe(DEFAULT_SIGTERM_GRACE_MS);
    expect(config.requiredControls).toEqual(DEFAULT_REQUIRED_CONTROLS);
    expect(Object.isFrozen(config.environment)).toBe(true);
    expect(Object.isFrozen(config.readonlyPaths)).toBe(true);
    // A default clock is provided when none is injected.
    expect(typeof config.clock.monotonicNs()).toBe("bigint");
    expect(config.clock.wallTimeUtc()).toMatch(/Z$/);
  });

  it("defensively copies the environment and readonly paths", () => {
    const environment = { PATH: "/usr/bin" };
    const readonlyPaths = ["/srv/problem"];
    const config = createLinuxSandboxConfig({
      ...SPEC,
      environment,
      readonlyPaths,
    });
    environment.PATH = "/tampered";
    readonlyPaths.push("/tampered");
    expect(config.environment.PATH).toBe("/usr/bin");
    expect(config.readonlyPaths).toEqual(["/srv/problem"]);
  });

  it("honors explicit grace window and required controls", () => {
    const config = createLinuxSandboxConfig({
      ...SPEC,
      sigtermGraceMs: 250,
      requiredControls: ["cgroup", "namespaces"],
    });
    expect(config.sigtermGraceMs).toBe(250);
    expect(config.requiredControls).toEqual(["cgroup", "namespaces"]);
  });

  it("rejects a blank absolute-path field", () => {
    expect(() =>
      createLinuxSandboxConfig({ ...SPEC, workingDirectory: "  " }),
    ).toThrow(RangeError);
  });

  it("rejects a relative path where an absolute one is required", () => {
    expect(() =>
      createLinuxSandboxConfig({ ...SPEC, cgroupParentPath: "relative/path" }),
    ).toThrow(RangeError);
  });

  it("rejects a non-positive grace window", () => {
    expect(() =>
      createLinuxSandboxConfig({ ...SPEC, sigtermGraceMs: 0 }),
    ).toThrow(RangeError);
  });
});
