/**
 * Unit tests for {@link probeEnforcement} — the fail-closed gate.
 *
 * The decision is the single place that upholds the spec's central safety rule:
 * a normal `passed` verdict is impossible when the host is not Linux or a
 * *required* control is unavailable. These tests drive the gate with a real
 * {@link CompositeControls} wrapping fake {@link SandboxControl}s, and stub
 * `process.platform` so both the Linux and non-Linux branches are covered on any
 * CI host.
 */

import { afterEach, describe, expect, it } from "vitest";

import { probeEnforcement } from "../../../src/execution/sandbox/linux/probe.js";
import {
  CompositeControls,
  type ControlId,
  type ControlProbe,
  type InstalledControl,
  type SandboxControl,
} from "../../../src/execution/sandbox/linux/controls/control.js";

/** A fake control whose probe result is fixed at construction. */
function fakeControl(
  id: ControlId,
  required: boolean,
  probe: ControlProbe,
): SandboxControl {
  return {
    id,
    required,
    probe: async (): Promise<ControlProbe> => probe,
    install: async (): Promise<InstalledControl> => ({
      argvPrefix: [],
      teardown: async () => [],
    }),
  };
}

const realPlatform = process.platform;

/** Temporarily force `process.platform` for a single test. */
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  setPlatform(realPlatform);
});

describe("probeEnforcement", () => {
  it("returns unsupported on a non-Linux platform", async () => {
    setPlatform("darwin");
    const controls = new CompositeControls([
      fakeControl("cgroup", true, { available: true }),
    ]);

    const decision = await probeEnforcement(controls);

    expect(decision.mode).toBe("unsupported");
    expect(decision.missingRequired).toEqual([]);
    expect(decision.reasons[0]).toContain("Linux");
  });

  it("fails closed when a required control is unavailable on Linux", async () => {
    setPlatform("linux");
    const controls = new CompositeControls([
      fakeControl("cgroup", true, {
        available: false,
        reason: "cgroup v2 not mounted",
      }),
    ]);

    const decision = await probeEnforcement(controls);

    expect(decision.mode).toBe("unsupported");
    expect(decision.missingRequired).toEqual<ControlId[]>(["cgroup"]);
    expect(decision.reasons[0]).toContain("cgroup v2 not mounted");
  });

  it("reports full enforcement when every required control is present", async () => {
    setPlatform("linux");
    const controls = new CompositeControls([
      fakeControl("cgroup", true, { available: true }),
      fakeControl("rlimits", false, { available: true }),
    ]);

    const decision = await probeEnforcement(controls);

    expect(decision.mode).toBe("full");
    expect(decision.reasons).toEqual([]);
    expect(decision.missingRequired).toEqual([]);
  });

  it("reports degraded when only optional controls are missing", async () => {
    setPlatform("linux");
    const controls = new CompositeControls([
      fakeControl("cgroup", true, { available: true }),
    ]);

    const decision = await probeEnforcement(controls, [
      "optional control 'namespaces': unshare not found",
    ]);

    expect(decision.mode).toBe("degraded");
    expect(decision.missingRequired).toEqual([]);
    expect(decision.reasons[0]).toContain("namespaces");
  });

  it("ignores unavailable optional controls for the fail-closed decision", async () => {
    setPlatform("linux");
    const controls = new CompositeControls([
      fakeControl("cgroup", true, { available: true }),
      fakeControl("namespaces", false, {
        available: false,
        reason: "no user namespaces",
      }),
    ]);

    // No optionalMissing passed → the gate only cares about required controls.
    const decision = await probeEnforcement(controls);

    expect(decision.mode).toBe("full");
    expect(decision.missingRequired).toEqual([]);
  });
});
