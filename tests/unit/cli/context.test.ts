import { describe, expect, it, vi } from "vitest";

import { AppContext } from "../../../src/cli/context.js";
import { ShutdownCoordinator } from "../../../src/cli/shutdown.js";

describe("AppContext", () => {
  it("opens persistence lazily and closes it exactly once", async () => {
    const close = vi.fn();
    const openStore = vi.fn(() => ({ close }) as never);
    const context = new AppContext({
      invocationDirectory: "/project",
      openStore,
    });
    expect(openStore).not.toHaveBeenCalled();
    expect(context.getStore()).toBe(context.getStore());
    expect(openStore).toHaveBeenCalledWith({
      path: "/project/.palestra/judge.sqlite",
    });
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

  it("installs a concrete watch handler rather than the deferred command stub", async () => {
    const context = new AppContext({
      invocationDirectory: "/project",
      openStore: () => ({ transaction: {}, close: () => undefined }) as never,
      emitWatchFact: () => undefined,
      fileSystem: {
        read: async () => {
          throw new Error("missing");
        },
        stat: async () => {
          throw new Error("missing");
        },
        discover: async () => [],
        createTempRoot: async () => "/tmp/watch",
        watchHints: () => ({ supportsRecursive: false, coalescingMs: 150 }),
        watch: async () => ({ close: async () => undefined }),
      },
    });
    context.cancellation.cancel();
    const result = await context.handlers.watch({
      name: "watch",
      correlationId: "test",
      options: {
        slug: "sample",
        solution: undefined,
        debounce: undefined,
        json: true,
        unsafeLocal: false,
      },
    });
    expect(result.status).toBe("canceled");
    await context.close();
  });
});
