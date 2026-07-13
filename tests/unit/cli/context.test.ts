import { describe, expect, it, vi } from "vitest";

import {
  AppContext,
  createBuiltInBackendRegistry,
  createPythonUvLinuxBackend,
} from "../../../src/cli/context.js";
import { ShutdownCoordinator } from "../../../src/cli/shutdown.js";

describe("AppContext", () => {
  it("installs the built-in Python backend factory under the problem runtime id", () => {
    const backend = createBuiltInBackendRegistry().require("python-uv");
    expect(backend.describe()).toMatchObject({ id: "python-uv", displayName: "Python via uv with Linux sandbox" });
    expect(() => backend.create()).toThrow("validated effective configuration");
  });

  it("opens persistence lazily and closes it exactly once", async () => {
    const close = vi.fn();
    const openStore = vi.fn(() => ({ close }) as never);
    const context = new AppContext({ invocationDirectory: "/project", openStore });
    expect(openStore).not.toHaveBeenCalled();
    expect(context.getStore()).toBe(context.getStore());
    expect(openStore).toHaveBeenCalledWith({ path: "/project/.palestra/judge.sqlite" });
    await context.close();
    await context.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("shares an injected coordinator's cancellation source with handlers", async () => {
    const coordinator = new ShutdownCoordinator();
    const context = new AppContext({ shutdown: coordinator });
    expect(context.cancellation).toBe(coordinator.cancellation);
    await coordinator.shutdown();
    expect(context.cancellation.isCancellationRequested).toBe(true);
  });

  it("rejects duplicate backend registration through the registry", () => {
    const registry = createBuiltInBackendRegistry();
    expect(() => registry.register(createPythonUvLinuxBackend())).toThrow("already registered");
  });
});
