import { describe, it, expect } from "vitest";

import { IllegalWatchTransitionError } from "../../../src/domain/errors.js";
import {
  WATCH_TRANSITIONS,
  WatchLifecycle,
  type WatchState,
} from "../../../src/domain/watch.js";

/** All watch states, used to build the exhaustive transition matrix. */
const ALL_STATES: readonly WatchState[] = [
  "stopped",
  "starting",
  "observing",
  "draining",
];

/**
 * Build a lifecycle positioned in `state` by walking legal transitions from the
 * initial stopped lifecycle. Keeps tests honest: reaching a state only ever
 * uses the public transition API, never a private constructor.
 */
function lifecycleIn(state: WatchState): WatchLifecycle {
  const base = WatchLifecycle.stopped();
  switch (state) {
    case "stopped":
      return base;
    case "starting":
      return base.start();
    case "observing":
      return base.start().observe();
    case "draining":
      return base.start().observe().drain();
  }
}

/** The method (if any) that names each direct transition, for API coverage. */
const NAMED_TRANSITION: Partial<
  Record<WatchState, Partial<Record<WatchState, keyof WatchLifecycle>>>
> = {
  stopped: { starting: "start" },
  starting: { observing: "observe", stopped: "stop" },
  observing: { draining: "drain", stopped: "stop" },
  draining: { stopped: "stop" },
};

// Enumerate every (from, to) pair and classify it against WATCH_TRANSITIONS.
const legalPairs: Array<{ from: WatchState; to: WatchState }> = [];
const illegalPairs: Array<{ from: WatchState; to: WatchState }> = [];
for (const from of ALL_STATES) {
  for (const to of ALL_STATES) {
    if (WATCH_TRANSITIONS[from].includes(to)) {
      legalPairs.push({ from, to });
    } else {
      illegalPairs.push({ from, to });
    }
  }
}

describe("WatchLifecycle.stopped", () => {
  it("starts in the stopped state at generation 0", () => {
    const lifecycle = WatchLifecycle.stopped();
    expect(lifecycle.state).toBe("stopped");
    expect(lifecycle.generation).toBe(0);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(WatchLifecycle.stopped())).toBe(true);
  });
});

describe("legal watch transitions", () => {
  it.each(legalPairs)(
    "$from -> $to yields the target state, preserves generation, and returns a new object",
    ({ from, to }) => {
      const before = lifecycleIn(from);
      const beforeGeneration = before.generation;

      const after = before.to(to);

      expect(after.state).toBe(to);
      // Plain transitions never touch the generation.
      expect(after.generation).toBe(beforeGeneration);
      // A new instance is returned; the receiver is untouched.
      expect(after).not.toBe(before);
      expect(before.state).toBe(from);
      expect(before.generation).toBe(beforeGeneration);
      // The returned instance is itself frozen.
      expect(Object.isFrozen(after)).toBe(true);
    },
  );

  it.each(legalPairs.filter(({ from, to }) => NAMED_TRANSITION[from]?.[to]))(
    "$from -> $to is also reachable via its named helper method",
    ({ from, to }) => {
      const method = NAMED_TRANSITION[from]?.[to] as keyof WatchLifecycle;
      const before = lifecycleIn(from);

      const viaMethod = (before[method] as () => WatchLifecycle).call(before);

      expect(viaMethod.state).toBe(to);
      expect(viaMethod.generation).toBe(before.generation);
      expect(viaMethod).not.toBe(before);
    },
  );
});

describe("illegal watch transitions", () => {
  it.each(illegalPairs)(
    "$from -> $to throws IllegalWatchTransitionError",
    ({ from, to }) => {
      const before = lifecycleIn(from);
      const beforeGeneration = before.generation;

      expect(() => before.to(to)).toThrow(IllegalWatchTransitionError);
      // Receiver is unchanged after a rejected transition.
      expect(before.state).toBe(from);
      expect(before.generation).toBe(beforeGeneration);
    },
  );
});

describe("rescan while observing", () => {
  it("increments the generation by exactly 1 and keeps state observing", () => {
    const observing = lifecycleIn("observing");
    expect(observing.generation).toBe(0);

    const rescanned = observing.rescan();

    expect(rescanned.state).toBe("observing");
    expect(rescanned.generation).toBe(1);
    // Returns a new frozen instance; the receiver is unchanged.
    expect(rescanned).not.toBe(observing);
    expect(observing.generation).toBe(0);
    expect(Object.isFrozen(rescanned)).toBe(true);
  });

  it("keeps incrementing the generation across repeated rescans", () => {
    let lifecycle = lifecycleIn("observing");
    for (let expected = 1; expected <= 5; expected += 1) {
      lifecycle = lifecycle.rescan();
      expect(lifecycle.state).toBe("observing");
      expect(lifecycle.generation).toBe(expected);
    }
  });
});

describe("rescan outside observing", () => {
  it.each<{ state: WatchState }>([
    { state: "stopped" },
    { state: "starting" },
    { state: "draining" },
  ])("throws IllegalWatchTransitionError when $state", ({ state }) => {
    const lifecycle = lifecycleIn(state);
    expect(() => lifecycle.rescan()).toThrow(IllegalWatchTransitionError);
    // Generation is not advanced on a rejected rescan.
    expect(lifecycle.generation).toBe(0);
  });
});
