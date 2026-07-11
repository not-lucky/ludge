/**
 * Unit tests for the pure domain ↔ row mappers.
 *
 * These exercise the translation layer in isolation (no database): the run
 * Memento round-trip, unsigned-64 seed encode/decode across `0`/max/`null`,
 * limits serialization, and the parameterized query-suffix builder.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_U64_SEED,
  buildRunWhere,
  decodeSeed,
  deserializeLimits,
  encodeSeed,
  rowToRun,
  runToRow,
  serializeLimits,
} from "../../../src/persistence/sqlite/mappers.js";
import { makeRun, sampleLimits } from "../../fixtures/persistence/index.js";

describe("run Memento mapping", () => {
  it("round-trips a run through runToRow → rowToRun unchanged", () => {
    const run = makeRun({ seed: "42" });
    expect(rowToRun(runToRow(run))).toEqual(run);
  });

  it("preserves a null seed and null output hash", () => {
    const run = makeRun({ seed: null, outputHash: null });
    const back = rowToRun(runToRow(run));
    expect(back.seed).toBeNull();
    expect(back.outputHash).toBeNull();
  });
});

describe("seed encoding", () => {
  it("accepts 0, the max u64, and null", () => {
    expect(encodeSeed("0")).toBe("0");
    expect(encodeSeed(MAX_U64_SEED.toString())).toBe(MAX_U64_SEED.toString());
    expect(encodeSeed(null)).toBeNull();
    expect(decodeSeed(MAX_U64_SEED.toString())).toBe(MAX_U64_SEED.toString());
  });

  it("rejects values above the u64 range", () => {
    expect(() => encodeSeed((MAX_U64_SEED + 1n).toString())).toThrow(RangeError);
  });

  it("rejects non-canonical decimal text", () => {
    expect(() => encodeSeed("01")).toThrow(RangeError);
    expect(() => encodeSeed("-1")).toThrow(RangeError);
    expect(() => encodeSeed("0x10")).toThrow(RangeError);
  });
});

describe("limits serialization", () => {
  it("round-trips resource limits through JSON", () => {
    const limits = sampleLimits();
    expect(deserializeLimits(serializeLimits(limits))).toEqual(limits);
  });
});

describe("buildRunWhere", () => {
  it("imposes no WHERE when the query is empty", () => {
    const { sql, params } = buildRunWhere({});
    expect(sql.startsWith(" ORDER BY")).toBe(true);
    expect(params).toEqual({});
  });

  it("binds every filter as a parameter", () => {
    const { sql, params } = buildRunWhere({
      slug: "two-sum",
      since: "2026-07-01T00:00:00.000Z",
      status: "passed",
      limit: 5,
    });
    expect(sql).toContain("slug = :slug");
    expect(sql).toContain("started_at >= :since");
    expect(sql).toContain("status = :status");
    expect(sql).toContain("LIMIT :limit");
    expect(params).toEqual({
      slug: "two-sum",
      since: "2026-07-01T00:00:00.000Z",
      status: "passed",
      limit: 5,
    });
  });

  it("rejects a negative limit", () => {
    expect(() => buildRunWhere({ limit: -1 })).toThrow(RangeError);
  });
});
