import { describe, it, expect } from "vitest";

import { IllegalRunTransitionError, StaleGenerationError } from "../../../src/domain/errors.js";
import { initialGeneration, nextGeneration } from "../../../src/domain/ids.js";
import type { Generation } from "../../../src/domain/ids.js";
import { RUN_TRANSITIONS, RunLifecycle } from "../../../src/domain/run.js";
import type { RunState } from "../../../src/domain/run.js";

const ALL_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "running",
  "canceling",
  "completed",
  "failed",
  "canceled",
];

const TERMINAL_STATES: readonly RunState[] = ["completed", "failed", "canceled"];

const GEN: Generation = initialGeneration();

/**
 * Build a lifecycle in `state` reached exclusively through legal transitions,
 * so tests exercise real state-machine paths rather than a synthetic constructor.
 */
function make(state: RunState, generation: Generation = GEN): RunLifecycle {
  const queued = RunLifecycle.queued(generation);
  switch (state) {
    case "queued":
      return queued;
    case "starting":
      return queued.start();
    case "running":
      return queued.start().run();
    case "canceling":
      return queued.start().run().to("canceling");
    case "completed":
      return queued.start().run().complete();
    case "failed":
      return queued.start().run().fail();
    case "canceled":
      return queued.start().run().to("canceling").confirmCanceled();
    default: {
      const exhaustive: never = state;
      throw new Error(`unreachable state ${String(exhaustive)}`);
    }
  }
}

// Flatten the adjacency map into (from, to) pairs for the exhaustive matrix.
const LEGAL_PAIRS: ReadonlyArray<readonly [RunState, RunState]> = ALL_STATES.flatMap(
  (from) => RUN_TRANSITIONS[from].map((to) => [from, to] as const),
);

const ILLEGAL_PAIRS: ReadonlyArray<readonly [RunState, RunState]> = ALL_STATES.flatMap(
  (from) =>
    ALL_STATES.filter((to) => !RUN_TRANSITIONS[from].includes(to)).map(
      (to) => [from, to] as const,
    ),
);

describe("RunLifecycle construction", () => {
  it("queued() starts in the queued state at the given generation", () => {
    const lc = RunLifecycle.queued(GEN);
    expect(lc.state).toBe("queued");
    expect(lc.generation).toBe(GEN);
    expect(lc.isTerminal).toBe(false);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(RunLifecycle.queued(GEN))).toBe(true);
    for (const state of ALL_STATES) {
      expect(Object.isFrozen(make(state))).toBe(true);
    }
  });
});

describe("legal transitions via to()", () => {
  it.each(LEGAL_PAIRS)("%s -> %s succeeds and is immutable", (from, to) => {
    const before = make(from);
    const after = before.to(to);

    expect(after.state).toBe(to);
    // A new instance is returned; the receiver is untouched.
    expect(after).not.toBe(before);
    expect(before.state).toBe(from);
    // Generation is preserved across transitions.
    expect(after.generation).toBe(before.generation);
  });
});

describe("illegal transitions via to()", () => {
  it.each(ILLEGAL_PAIRS)("%s -> %s throws IllegalRunTransitionError", (from, to) => {
    const before = make(from);
    expect(() => before.to(to)).toThrow(IllegalRunTransitionError);
    // Receiver is unchanged after a rejected transition.
    expect(before.state).toBe(from);
  });
});

describe("terminal states cannot escape", () => {
  it.each(TERMINAL_STATES)("%s rejects every to() target", (terminal) => {
    const lc = make(terminal);
    expect(lc.isTerminal).toBe(true);
    for (const target of ALL_STATES) {
      expect(() => lc.to(target)).toThrow(IllegalRunTransitionError);
    }
  });
});

describe("named transition helpers", () => {
  it("start(): queued -> starting", () => {
    expect(RunLifecycle.queued(GEN).start().state).toBe("starting");
  });

  it("run(): starting -> running", () => {
    expect(make("starting").run().state).toBe("running");
  });

  it("complete(): running -> completed", () => {
    const lc = make("running").complete();
    expect(lc.state).toBe("completed");
    expect(lc.isTerminal).toBe(true);
  });

  it("fail(): running -> failed", () => {
    const lc = make("running").fail();
    expect(lc.state).toBe("failed");
    expect(lc.isTerminal).toBe(true);
  });

  it("confirmCanceled(): canceling -> canceled", () => {
    const lc = make("canceling").confirmCanceled();
    expect(lc.state).toBe("canceled");
    expect(lc.isTerminal).toBe(true);
  });
});

describe("requestCancel()", () => {
  it("running -> canceling", () => {
    const before = make("running");
    const after = before.requestCancel();
    expect(after.state).toBe("canceling");
    expect(after).not.toBe(before);
    expect(before.state).toBe("running");
  });

  it("starting -> canceled", () => {
    const before = make("starting");
    const after = before.requestCancel();
    expect(after.state).toBe("canceled");
    expect(after).not.toBe(before);
    expect(before.state).toBe("starting");
  });

  it.each(["queued", "canceling"] as const)(
    "%s is a no-op that returns the same instance",
    (state) => {
      const before = make(state);
      const after = before.requestCancel();
      expect(after).toBe(before);
      expect(after.state).toBe(state);
    },
  );

  it.each(TERMINAL_STATES)("%s is unchanged and does not throw", (terminal) => {
    const before = make(terminal);
    let after: RunLifecycle | undefined;
    expect(() => {
      after = before.requestCancel();
    }).not.toThrow();
    expect(after).toBe(before);
    expect(before.state).toBe(terminal);
  });
});

describe("settleFromResult() generation guard", () => {
  const older = initialGeneration();
  const current = nextGeneration(older);
  const newer = nextGeneration(current);

  it("rejects a result from an older generation with StaleGenerationError", () => {
    const lc = RunLifecycle.queued(current).start().run();
    expect(() => lc.settleFromResult(older, "completed")).toThrow(StaleGenerationError);
    expect(() => lc.settleFromResult(older, "failed")).toThrow(StaleGenerationError);
    // No transition occurred.
    expect(lc.state).toBe("running");
  });

  it("settles to completed from a same-generation result", () => {
    const lc = RunLifecycle.queued(current).start().run();
    const settled = lc.settleFromResult(current, "completed");
    expect(settled.state).toBe("completed");
    expect(settled.generation).toBe(current);
    expect(lc.state).toBe("running");
  });

  it("settles to failed from a same-generation result", () => {
    const lc = RunLifecycle.queued(current).start().run();
    expect(lc.settleFromResult(current, "failed").state).toBe("failed");
  });

  it("settles from a newer-generation result", () => {
    const lc = RunLifecycle.queued(current).start().run();
    expect(lc.settleFromResult(newer, "completed").state).toBe("completed");
    expect(lc.settleFromResult(newer, "failed").state).toBe("failed");
  });

  it("still enforces transition legality when the generation is acceptable", () => {
    // queued has no legal edge to completed/failed even at a valid generation.
    const lc = RunLifecycle.queued(current);
    expect(() => lc.settleFromResult(current, "completed")).toThrow(
      IllegalRunTransitionError,
    );
  });
});
