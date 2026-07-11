/**
 * Unit tests for {@link BoundedCollector}.
 *
 * These exercise the Decorator's two invariants in isolation (no process is
 * spawned): it retains at most `capBytes` yet keeps counting every byte it sees,
 * so `truncated`/`totalBytes` reflect the whole stream even after the cap is hit.
 */

import { describe, expect, it } from "vitest";

import { BoundedCollector } from "../../../src/execution/sandbox/linux/output-collector.js";

/** Build a byte chunk of `length` filled with a repeating marker byte. */
function chunk(length: number, fill = 0x61): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe("BoundedCollector", () => {
  it("retains every byte when the stream stays under the cap", () => {
    const collector = new BoundedCollector(16);
    collector.push(chunk(4, 0x41));
    collector.push(chunk(4, 0x42));

    expect(collector.totalBytes).toBe(8);
    expect(collector.truncated).toBe(false);
    expect(collector.bytes()).toEqual(
      new Uint8Array([...chunk(4, 0x41), ...chunk(4, 0x42)]),
    );
  });

  it("retains only the prefix that fits and flags truncation", () => {
    const collector = new BoundedCollector(6);
    collector.push(chunk(4, 0x41));
    collector.push(chunk(4, 0x42));

    // Cap is 6: all 4 of the first chunk, then only 2 of the second.
    expect(collector.bytes()).toEqual(
      new Uint8Array([...chunk(4, 0x41), ...chunk(2, 0x42)]),
    );
    expect(collector.truncated).toBe(true);
  });

  it("counts bytes seen past the cap toward totalBytes", () => {
    const collector = new BoundedCollector(6);
    collector.push(chunk(10));
    collector.push(chunk(10));

    // Only 6 retained, but all 20 counted (the drain keeps going).
    expect(collector.totalBytes).toBe(20);
    expect(collector.bytes().byteLength).toBe(6);
    expect(collector.truncated).toBe(true);
  });

  it("stores nothing once the cap is exhausted but keeps draining", () => {
    const collector = new BoundedCollector(4);
    collector.push(chunk(4));
    // Cap already full: subsequent chunks are counted but not stored.
    collector.push(chunk(100));

    expect(collector.bytes().byteLength).toBe(4);
    expect(collector.totalBytes).toBe(104);
    expect(collector.truncated).toBe(true);
  });

  it("handles a zero cap by counting without retaining", () => {
    const collector = new BoundedCollector(0);
    collector.push(chunk(8));

    expect(collector.bytes().byteLength).toBe(0);
    expect(collector.totalBytes).toBe(8);
    expect(collector.truncated).toBe(true);
  });

  it("is not truncated for an exactly-full stream", () => {
    const collector = new BoundedCollector(8);
    collector.push(chunk(8));

    expect(collector.truncated).toBe(false);
    expect(collector.totalBytes).toBe(8);
    expect(collector.bytes().byteLength).toBe(8);
  });

  it("snapshots to the BoundedOutput domain value", () => {
    const collector = new BoundedCollector(3);
    collector.push(chunk(5, 0x7a));

    const output = collector.toBoundedOutput();
    expect(output.data).toEqual(chunk(3, 0x7a));
    expect(output.truncated).toBe(true);
    expect(output.totalBytes).toBe(5);
  });

  it("reports an empty, untruncated snapshot when nothing was pushed", () => {
    const collector = new BoundedCollector(16);
    expect(collector.totalBytes).toBe(0);
    expect(collector.truncated).toBe(false);
    expect(collector.bytes().byteLength).toBe(0);
  });
});
