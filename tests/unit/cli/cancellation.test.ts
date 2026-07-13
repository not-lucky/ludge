import { describe, expect, it, vi } from "vitest";

import {
  CancellationError,
  CancellationSource,
} from "../../../src/cli/cancellation.js";

describe("CancellationSource", () => {
  it("implements the execution CancellationToken contract and latches", () => {
    const source = new CancellationSource();
    const calls: string[] = [];
    const unsubscribe = source.token.onCancel(() => calls.push("first"));

    expect(source.token.isCancellationRequested).toBe(false);
    expect(() => source.token.throwIfCancellationRequested()).not.toThrow();

    source.cancel();
    source.cancel();
    unsubscribe();

    expect(source.token.isCancellationRequested).toBe(true);
    expect(calls).toEqual(["first"]);
    expect(() => source.token.throwIfCancellationRequested()).toThrow(
      CancellationError,
    );
  });

  it("notifies late subscribers immediately and gives them a harmless unsubscribe", () => {
    const source = new CancellationSource();
    source.cancel();
    const listener = vi.fn();

    const unsubscribe = source.onCancel(listener);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify an unsubscribed listener", () => {
    const source = new CancellationSource();
    const listener = vi.fn();
    source.onCancel(listener)();

    source.cancel();

    expect(listener).not.toHaveBeenCalled();
  });
});
