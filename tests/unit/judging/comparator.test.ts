/**
 * Unit tests for the `exact-v1` output comparator and its version dispatch.
 *
 * These exercise the task-05 acceptance criteria: exact semantic equality and
 * first-mismatch reporting; numeric tolerance confined to finite float/decimal
 * leaves (never int/str/shape/exception); canonical-byte equality as an explicit
 * mode; whitespace normalization limited to text; and rejection of an
 * unsupported comparator major version while accepting supported minors.
 */

import { describe, it, expect } from "vitest";
import {
  createOutputComparator,
  UnsupportedComparisonPolicyError,
  isSupportedPolicyVersion,
  parsePolicyVersion,
} from "../../../src/judging/comparator/index.js";
import type { CanonicalValue } from "../../../src/judging/value/model.js";
import type { ComparisonPolicy } from "../../../src/domain/index.js";

const comparator = createOutputComparator();

/** A `semantic` policy with the given overrides. */
function policy(overrides: Partial<ComparisonPolicy> = {}): ComparisonPolicy {
  return {
    version: "exact-v1",
    equality: "semantic",
    normalizeWhitespace: false,
    ...overrides,
  };
}

/** Assert the two values compare equal under `p`. */
function expectEqual(
  expected: CanonicalValue,
  actual: CanonicalValue,
  p: ComparisonPolicy = policy(),
): void {
  expect(comparator.compare(expected, actual, p)).toEqual({ equal: true });
}

/** Assert a mismatch and return it for further inspection. */
function expectMismatch(
  expected: CanonicalValue,
  actual: CanonicalValue,
  p: ComparisonPolicy = policy(),
): { path: string; reason: string } {
  const result = comparator.compare(expected, actual, p);
  expect(result.equal).toBe(false);
  if (result.equal) {
    throw new Error("expected a mismatch");
  }
  return { path: result.mismatch.path, reason: result.mismatch.reason };
}

describe("exact-v1 semantic equality", () => {
  const equalCases: readonly [string, CanonicalValue][] = [
    ["null", { tag: "null" }],
    ["bool", { tag: "bool", value: true }],
    ["int", { tag: "int", value: 123456789012345678901234567890n }],
    ["float", { tag: "float", value: "3.14", negativeZero: false }],
    ["decimal", { tag: "decimal", value: "1.230" }],
    ["str", { tag: "str", value: "héllo" }],
    ["bytes", { tag: "bytes", encoding: "base64url", value: "aGVsbG8" }],
    ["date", { tag: "date", value: "2026-07-20" }],
    ["uuid", { tag: "uuid", value: "123e4567-e89b-12d3-a456-426614174000" }],
    ["path", { tag: "path", value: "a/b", flavor: "posix" }],
    [
      "dict",
      {
        tag: "dict",
        entries: [
          {
            key: { tag: "int", value: 1n },
            value: { tag: "str", value: "one" },
          },
        ],
      },
    ],
    [
      "set",
      {
        tag: "set",
        items: [
          { tag: "int", value: 1n },
          { tag: "int", value: 2n },
        ],
      },
    ],
    [
      "exception",
      { tag: "exception", type: "ValueError", message: "bad", details: null },
    ],
  ];

  it.each(equalCases)("treats identical %s values as equal", (_name, value) => {
    expectEqual(value, value);
  });

  it("reports the first differing leaf path in a nested list", () => {
    const expected: CanonicalValue = {
      tag: "list",
      items: [
        { tag: "int", value: 1n },
        { tag: "list", items: [{ tag: "int", value: 2n }] },
      ],
    };
    const actual: CanonicalValue = {
      tag: "list",
      items: [
        { tag: "int", value: 1n },
        { tag: "list", items: [{ tag: "int", value: 3n }] },
      ],
    };
    expect(expectMismatch(expected, actual).path).toBe("$.items[1].items[0]");
  });

  it("reports a tag difference at the root", () => {
    const { path, reason } = expectMismatch(
      { tag: "int", value: 1n },
      { tag: "str", value: "1" },
    );
    expect(path).toBe("$");
    expect(reason).toBe("tag differs");
  });

  it("treats -0.0 and 0.0 as distinct without tolerance", () => {
    expectMismatch(
      { tag: "float", value: "0", negativeZero: true },
      { tag: "float", value: "0", negativeZero: false },
    );
  });

  it("distinguishes bool from int (never coerced)", () => {
    expectMismatch({ tag: "bool", value: true }, { tag: "int", value: 1n });
  });

  it("reports a dict key path when keys differ", () => {
    const expected: CanonicalValue = {
      tag: "dict",
      entries: [
        { key: { tag: "int", value: 1n }, value: { tag: "str", value: "a" } },
      ],
    };
    const actual: CanonicalValue = {
      tag: "dict",
      entries: [
        { key: { tag: "int", value: 2n }, value: { tag: "str", value: "a" } },
      ],
    };
    expect(expectMismatch(expected, actual).path).toBe("$.entries[0].key");
  });
});

describe("exact-v1 numeric tolerance", () => {
  const tol = (absolute: number, relative: number): ComparisonPolicy =>
    policy({ tolerance: { absolute, relative } });

  it("accepts floats within the absolute bound", () => {
    expectEqual(
      { tag: "float", value: "1", negativeZero: false },
      { tag: "float", value: "1.005", negativeZero: false },
      tol(0.01, 0),
    );
  });

  it("rejects floats outside the absolute bound", () => {
    const { reason } = expectMismatch(
      { tag: "float", value: "1", negativeZero: false },
      { tag: "float", value: "1.5", negativeZero: false },
      tol(0.01, 0),
    );
    expect(reason).toBe("float outside tolerance");
  });

  it("accepts floats within the relative bound", () => {
    expectEqual(
      { tag: "float", value: "1000", negativeZero: false },
      { tag: "float", value: "1001", negativeZero: false },
      tol(0, 0.01),
    );
  });

  it("accepts decimals within tolerance", () => {
    expectEqual(
      { tag: "decimal", value: "2.50" },
      { tag: "decimal", value: "2.5001" },
      tol(0.001, 0),
    );
  });

  it("applies tolerance to complex float parts", () => {
    expectEqual(
      {
        tag: "complex",
        real: { tag: "float", value: "1", negativeZero: false },
        imag: { tag: "float", value: "2", negativeZero: false },
      },
      {
        tag: "complex",
        real: { tag: "float", value: "1.001", negativeZero: false },
        imag: { tag: "float", value: "2", negativeZero: false },
      },
      tol(0.01, 0),
    );
  });

  it("does NOT relax integers", () => {
    expectMismatch(
      { tag: "int", value: 1n },
      { tag: "int", value: 2n },
      tol(5, 5),
    );
  });

  it("does NOT relax strings", () => {
    expectMismatch(
      { tag: "str", value: "1" },
      { tag: "str", value: "2" },
      tol(5, 5),
    );
  });

  it("does NOT relax container shape (list length)", () => {
    const { reason } = expectMismatch(
      {
        tag: "list",
        items: [{ tag: "float", value: "1", negativeZero: false }],
      },
      { tag: "list", items: [] },
      tol(100, 100),
    );
    expect(reason).toBe("length differs");
  });

  it("does NOT relax exception details", () => {
    expectMismatch(
      {
        tag: "exception",
        type: "E",
        message: "m",
        details: { tag: "float", value: "1", negativeZero: false },
      },
      {
        tag: "exception",
        type: "E",
        message: "m",
        details: { tag: "float", value: "1.001", negativeZero: false },
      },
      tol(0.01, 0),
    );
  });

  it("does NOT bridge a float/decimal type difference", () => {
    expectMismatch(
      { tag: "float", value: "1", negativeZero: false },
      { tag: "decimal", value: "1" },
      tol(1, 1),
    );
  });
});

describe("exact-v1 canonical byte equality", () => {
  const bytesPolicy = policy({ equality: "canonical_bytes" });

  it("treats values with identical canonical form as equal", () => {
    const value: CanonicalValue = {
      tag: "set",
      items: [
        { tag: "int", value: 2n },
        { tag: "int", value: 1n },
      ],
    };
    // Same logical set, differing input order → identical canonical bytes.
    const reordered: CanonicalValue = {
      tag: "set",
      items: [
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
      ],
    };
    expectEqual(value, reordered, bytesPolicy);
  });

  it("reports a root-level mismatch for differing bytes", () => {
    const { path, reason } = expectMismatch(
      { tag: "int", value: 1n },
      { tag: "int", value: 2n },
      bytesPolicy,
    );
    expect(path).toBe("$");
    expect(reason).toBe("canonical bytes differ");
  });

  it("ignores tolerance in byte mode (floats must match exactly)", () => {
    expectMismatch(
      { tag: "float", value: "1", negativeZero: false },
      { tag: "float", value: "1.001", negativeZero: false },
      policy({
        equality: "canonical_bytes",
        tolerance: { absolute: 1, relative: 1 },
      }),
    );
  });
});

describe("exact-v1 whitespace normalization", () => {
  it("collapses whitespace for str when enabled", () => {
    expectEqual(
      { tag: "str", value: "  a\t b\n" },
      { tag: "str", value: "a b" },
      policy({ normalizeWhitespace: true }),
    );
  });

  it("does not normalize when disabled", () => {
    expectMismatch(
      { tag: "str", value: "a  b" },
      { tag: "str", value: "a b" },
      policy({ normalizeWhitespace: false }),
    );
  });

  it("never normalizes non-text leaves", () => {
    // A path is not text; whitespace-looking differences are still significant.
    expectMismatch(
      { tag: "path", value: "a/b", flavor: "posix" },
      { tag: "path", value: "a/c", flavor: "posix" },
      policy({ normalizeWhitespace: true }),
    );
  });
});

describe("comparison-policy version dispatch", () => {
  it("accepts the exact-v1 version", () => {
    expect(isSupportedPolicyVersion("exact-v1")).toBe(true);
  });

  it("accepts a supported minor migration", () => {
    expect(isSupportedPolicyVersion("exact-v1.3")).toBe(true);
    expectEqual(
      { tag: "int", value: 1n },
      { tag: "int", value: 1n },
      policy({ version: "exact-v1.3" }),
    );
  });

  it("rejects an unsupported major version", () => {
    expect(isSupportedPolicyVersion("exact-v2")).toBe(false);
    expect(() =>
      comparator.compare(
        { tag: "null" },
        { tag: "null" },
        policy({ version: "exact-v2" }),
      ),
    ).toThrow(UnsupportedComparisonPolicyError);
  });

  it("rejects an unrecognized version string", () => {
    expect(parsePolicyVersion("not-a-version")).toBeNull();
    expect(() =>
      comparator.compare(
        { tag: "null" },
        { tag: "null" },
        policy({ version: "garbage" }),
      ),
    ).toThrow(UnsupportedComparisonPolicyError);
  });

  it("parses family, major, and minor", () => {
    expect(parsePolicyVersion("exact-v1")).toEqual({
      family: "exact",
      major: 1,
      minor: 0,
    });
    expect(parsePolicyVersion("exact-v2.5")).toEqual({
      family: "exact",
      major: 2,
      minor: 5,
    });
  });
});
