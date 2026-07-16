import { describe, expect, it } from "vitest";

import {
  UINT64_MAX,
  formatUint64Seed,
  pairedFisherYatesOrder,
  parseUint64Seed,
} from "../../../src/benchmark/ordering.js";

describe("pairedFisherYatesOrder", () => {
  const implementations = [
    "baseline",
    "candidate-a",
    "candidate-b",
    "candidate-c",
  ] as const;

  it("repeats the exact Fisher-Yates order for a persisted uint64 seed and coordinates", () => {
    const seed = parseUint64Seed("18446744073709551615");
    const first = pairedFisherYatesOrder(implementations, seed, 7, 13);
    const second = pairedFisherYatesOrder(implementations, seed, 7, 13);

    expect(first).toEqual(second);
    expect(first).toHaveLength(implementations.length);
    expect([...first].sort()).toEqual([...implementations].sort());
    expect(implementations).toEqual([
      "baseline",
      "candidate-a",
      "candidate-b",
      "candidate-c",
    ]);
  });

  it("derives independent orders for every case/ordinal coordinate while keeping all solutions paired", () => {
    const seed = parseUint64Seed("42");
    const orders = [
      pairedFisherYatesOrder(implementations, seed, 0, 0),
      pairedFisherYatesOrder(implementations, seed, 0, 1),
      pairedFisherYatesOrder(implementations, seed, 1, 0),
    ];

    for (const order of orders)
      expect([...order].sort()).toEqual([...implementations].sort());
    // These coordinates are domain-separated, not successive consumption of one
    // shared PRNG stream. Reconstructing one is unaffected by requesting others.
    expect(pairedFisherYatesOrder(implementations, seed, 0, 0)).toEqual(
      orders[0],
    );
  });

  it("accepts and formats only canonical uint64 seed values", () => {
    expect(formatUint64Seed(parseUint64Seed("0"))).toBe("0");
    expect(formatUint64Seed(UINT64_MAX)).toBe("18446744073709551615");
    for (const invalid of ["", "-1", "+1", "01", "18446744073709551616"]) {
      expect(() => parseUint64Seed(invalid)).toThrow(RangeError);
    }
  });
});
