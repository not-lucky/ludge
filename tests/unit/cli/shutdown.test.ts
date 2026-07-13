import { describe, expect, it, vi } from "vitest";

import {
  ShutdownCoordinator,
  type ShutdownSignal,
} from "../../../src/cli/shutdown.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ShutdownCoordinator", () => {
  it("stops new work, cancels, drains active work, then cleans in LIFO order", async () => {
    const events: string[] = [];
    const coordinator = new ShutdownCoordinator();
    coordinator.cancellation.onCancel(() => events.push("cancel"));
    coordinator.registerCleanup(() => events.push("store"));
    coordinator.registerCleanup(() => events.push("child"));
    const work = coordinator.beginWork();

    expect(work).toBeDefined();
    const shutdown = coordinator.shutdown();

    expect(coordinator.isAcceptingWork).toBe(false);
    expect(coordinator.beginWork()).toBeUndefined();
    expect(events).toEqual(["cancel"]);

    work?.complete();
    await shutdown;

    expect(events).toEqual(["cancel", "child", "store"]);
    expect(coordinator.isClosed).toBe(true);
  });

  it("shares a drain, runs each cleanup once, and continues after cleanup errors", async () => {
    const reported: unknown[] = [];
    const cleanup = vi.fn();
    const coordinator = new ShutdownCoordinator({
      onCleanupError: (error) => reported.push(error),
    });
    coordinator.registerCleanup(cleanup);
    coordinator.registerCleanup(() => {
      throw new Error("failed cleanup");
    });

    const first = coordinator.shutdown();
    const second = coordinator.shutdown();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await coordinator.shutdown();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
  });

  it("includes cleanup registered during cancellation and permits deregistration", async () => {
    const events: string[] = [];
    const coordinator = new ShutdownCoordinator();
    const remove = coordinator.registerCleanup(() => events.push("removed"));
    remove();
    coordinator.cancellation.onCancel(() => {
      coordinator.registerCleanup(() => events.push("late"));
    });

    await coordinator.shutdown();

    expect(events).toEqual(["late"]);
  });

  it("registers each signal once and exits once with 130 after drain", async () => {
    const listeners = new Map<ShutdownSignal, () => void>();
    const removals: ShutdownSignal[] = [];
    const exit = vi.fn();
    const active = deferred();
    const coordinator = new ShutdownCoordinator({
      registerSignal: (signal, listener) => {
        listeners.set(signal, listener);
        return () => {
          removals.push(signal);
          listeners.delete(signal);
        };
      },
      exit,
    });
    coordinator.installSignalHandlers();
    coordinator.installSignalHandlers();
    const work = coordinator.beginWork();
    coordinator.registerCleanup(async () => {
      await active.promise;
    });

    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();
    expect(coordinator.cancellation.isCancellationRequested).toBe(true);
    expect(exit).not.toHaveBeenCalled();

    work?.complete();
    active.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(removals.sort()).toEqual(["SIGINT", "SIGTERM"]);
  });
});
