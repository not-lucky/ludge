import { describe, expect, it, vi } from "vitest";

import { initialGeneration } from "../../../src/domain/index.js";
import {
  WatchMediator,
  type WatchTargetSnapshot,
} from "../../../src/watch/index.js";

class FakeTimer {
  private next = 0;
  private readonly tasks = new Map<number, () => void>();
  public after(_milliseconds: number, callback: () => void): () => void {
    const id = this.next++;
    this.tasks.set(id, callback);
    return () => this.tasks.delete(id);
  }
  public flush(): void {
    while (this.tasks.size > 0) {
      const tasks = [...this.tasks.values()];
      this.tasks.clear();
      for (const task of tasks) task();
    }
  }
}

const target = {
  id: "sample",
  slug: "sample",
  problemRoot: "/project/problems/sample",
} as const;
function snapshot(value: string): WatchTargetSnapshot {
  return Object.freeze({
    target: "sample",
    files: Object.freeze([]),
    inputHash: `input-${value}`,
    configurationHash: `config-${value}`,
  });
}

/** Let Promise continuations and deterministic timer callbacks settle together. */
async function settle(timer: FakeTimer): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    await Promise.resolve();
    timer.flush();
  }
}

describe("WatchMediator", () => {
  it("coalesces rapid hints into one successor generation", async () => {
    const timer = new FakeTimer();
    let current = snapshot("zero");
    const runs: number[] = [];
    const mediator = new WatchMediator([target], {
      timer,
      snapshots: {
        scan: async () => current,
        stable: async (_target, value) => value,
      },
      createRunId: () => `run-${runs.length}`,
      run: async (request) => {
        runs.push(request.generation);
        return { result: null, commit: async () => undefined };
      },
    });
    await mediator.start();
    await settle(timer);
    current = snapshot("one");
    mediator.hint("sample");
    mediator.hint("sample");
    mediator.hint("sample");
    timer.flush();
    await settle(timer);
    expect(runs).toEqual([initialGeneration(), 1]);
  });

  it("cancels a stale active generation and commits only the replacement", async () => {
    const timer = new FakeTimer();
    let current = snapshot("zero");
    let releaseFirst: (() => void) | undefined;
    const committed: number[] = [];
    const canceled: string[] = [];
    const mediator = new WatchMediator([target], {
      timer,
      snapshots: {
        scan: async () => current,
        stable: async (_target, value) => value,
      },
      createRunId: (() => {
        let id = 0;
        return () => `run-${id++}`;
      })(),
      emit: (fact) => {
        if (fact.event === "watch.cancel") canceled.push(fact.reason ?? "");
      },
      run: async (request) => {
        if (request.generation === 0)
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        return {
          result: null,
          commit: async () => {
            committed.push(request.generation);
          },
        };
      },
    });
    await mediator.start();
    await settle(timer);
    current = snapshot("one");
    mediator.hint("sample");
    timer.flush();
    await settle(timer);
    releaseFirst?.();
    await settle(timer);
    expect(committed).toEqual([1]);
    expect(canceled).toContain("superseded");
  });

  it("suppresses commit when a fresh rescan no longer matches captured hashes", async () => {
    const timer = new FakeTimer();
    let value = snapshot("zero");
    let release: (() => void) | undefined;
    const commit = vi.fn(async () => undefined);
    const mediator = new WatchMediator([target], {
      timer,
      snapshots: {
        scan: async () => value,
        stable: async (_target, candidate) => candidate,
      },
      createRunId: () => "run",
      run: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { result: null, commit };
      },
    });
    await mediator.start();
    await settle(timer);
    value = snapshot("changed-without-hint");
    release?.();
    await settle(timer);
    expect(commit).not.toHaveBeenCalled();
  });

  it("reschedules every target after an overflow hint", async () => {
    const timer = new FakeTimer();
    const targets = ["one", "two"].map((id) => ({
      id,
      slug: id,
      problemRoot: `/project/problems/${id}`,
    }));
    const values = new Map(
      targets.map((item) => [
        item.id,
        Object.freeze({
          target: item.id,
          files: Object.freeze([]),
          inputHash: "zero",
          configurationHash: "zero",
        }),
      ]),
    );
    const generations: number[] = [];
    const mediator = new WatchMediator(targets, {
      timer,
      snapshots: {
        scan: async (item) => values.get(item.id)!,
        stable: async (_target, candidate) => candidate,
      },
      createRunId: (() => {
        let id = 0;
        return () => `run-${id++}`;
      })(),
      run: async (request) => {
        generations.push(request.generation);
        return { result: null, commit: async () => undefined };
      },
    });
    await mediator.start();
    await settle(timer);
    for (const item of targets)
      values.set(
        item.id,
        Object.freeze({
          target: item.id,
          files: Object.freeze([]),
          inputHash: "one",
          configurationHash: "zero",
        }),
      );
    mediator.hintAll("overflow");
    timer.flush();
    await settle(timer);
    expect(generations).toEqual([0, 0, 1, 1]);
  });

  it("enforces two global execution slots while pending targets wait", async () => {
    const timer = new FakeTimer();
    const targets = ["one", "two", "three"].map((id) => ({
      id,
      slug: id,
      problemRoot: `/project/problems/${id}`,
    }));
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const mediator = new WatchMediator(targets, {
      timer,
      slots: 2,
      snapshots: {
        scan: async (item) =>
          Object.freeze({
            target: item.id,
            files: Object.freeze([]),
            inputHash: item.id,
            configurationHash: item.id,
          }),
        stable: async (_target, value) => value,
      },
      createRunId: (() => {
        let id = 0;
        return () => `run-${id++}`;
      })(),
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { result: null, commit: async () => undefined };
      },
    });
    await mediator.start();
    await settle(timer);
    expect(peak).toBe(2);
    releases.shift()?.();
    await settle(timer);
    expect(peak).toBe(2);
    while (releases.length > 0) releases.shift()?.();
    await settle(timer);
  });

  it("reaps an active child when draining", async () => {
    const timer = new FakeTimer();
    let release: (() => void) | undefined;
    const run = vi.fn(
      async (request: {
        readonly cancellation: { readonly isCancellationRequested: boolean };
      }) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        expect(request.cancellation.isCancellationRequested).toBe(true);
        return { result: null, commit: async () => undefined };
      },
    );
    const mediator = new WatchMediator([target], {
      timer,
      snapshots: {
        scan: async () => snapshot("zero"),
        stable: async (_target, value) => value,
      },
      createRunId: () => "run",
      run,
    });
    await mediator.start();
    await settle(timer);
    const draining = mediator.drain();
    release?.();
    await draining;
    expect(mediator.isObserving).toBe(false);
  });
});
