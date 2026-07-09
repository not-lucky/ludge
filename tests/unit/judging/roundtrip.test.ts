/**
 * Round-trip and determinism tests for the `tagged-jsonl-v1` codec.
 *
 * For every canonical tag, a value in canonical form must survive
 * `encode` -> `decode` unchanged, and encoding the same value twice must yield
 * byte-identical output (the property that makes byte-equality judging sound).
 */

import { describe, it, expect } from "vitest";
import { createTaggedJsonlV1Codec } from "../../../src/judging/codec/index.js";
import type { CanonicalValue } from "../../../src/judging/value/index.js";

const codec = createTaggedJsonlV1Codec("test-backend");

/** Encode then decode, asserting success, and return the decoded value. */
function roundTrip(value: CanonicalValue): CanonicalValue {
  const bytes = codec.encode(value);
  const result = codec.decode(bytes);
  if (!result.ok) {
    throw new Error(`decode failed: ${result.error.message}`);
  }
  return result.value;
}

/** A representative, already-canonical value for each tag. */
const cases: readonly [name: string, value: CanonicalValue][] = [
  ["null", { tag: "null" }],
  ["bool true", { tag: "bool", value: true }],
  ["bool false", { tag: "bool", value: false }],
  ["int small", { tag: "int", value: 42n }],
  ["int negative", { tag: "int", value: -7n }],
  ["int large", { tag: "int", value: 9_007_199_254_740_993n }],
  ["int very large", { tag: "int", value: 123456789012345678901234567890n }],
  ["float", { tag: "float", value: "3.14", negativeZero: false }],
  ["float exponent", { tag: "float", value: "1.5e+10", negativeZero: false }],
  ["float negative zero", { tag: "float", value: "0", negativeZero: true }],
  ["decimal", { tag: "decimal", value: "1.230" }],
  [
    "complex",
    {
      tag: "complex",
      real: { tag: "float", value: "1.5", negativeZero: false },
      imag: { tag: "int", value: 2n },
    },
  ],
  ["str", { tag: "str", value: "héllo \u{1f600}" }],
  [
    "list",
    {
      tag: "list",
      items: [
        { tag: "int", value: 1n },
        { tag: "str", value: "x" },
      ],
    },
  ],
  [
    "tuple",
    { tag: "tuple", items: [{ tag: "bool", value: true }] },
  ],
  [
    "set (canonical order)",
    {
      tag: "set",
      items: [
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
      ],
    },
  ],
  [
    "frozenset",
    { tag: "frozenset", items: [{ tag: "str", value: "a" }] },
  ],
  [
    "dict (canonical key order)",
    {
      tag: "dict",
      entries: [
        { key: { tag: "int", value: 1n }, value: { tag: "str", value: "one" } },
        { key: { tag: "int", value: 2n }, value: { tag: "str", value: "two" } },
      ],
    },
  ],
  ["bytes", { tag: "bytes", encoding: "base64url", value: "aGVsbG8" }],
  ["date", { tag: "date", value: "2026-07-19" }],
  [
    "time naive",
    { tag: "time", value: "12:34:56", offsetMinutes: null, fold: 0 },
  ],
  [
    "time aware",
    { tag: "time", value: "12:34:56.500000", offsetMinutes: 120, fold: 1 },
  ],
  [
    "datetime",
    {
      tag: "datetime",
      value: "2026-07-19T12:34:56",
      offsetMinutes: 0,
      fold: 0,
    },
  ],
  ["uuid", { tag: "uuid", value: "123e4567-e89b-12d3-a456-426614174000" }],
  ["path posix", { tag: "path", value: "a/b/c.txt", flavor: "posix" }],
  ["path windows", { tag: "path", value: "a\\b\\c.txt", flavor: "windows" }],
  [
    "enum",
    {
      tag: "enum",
      type: "Color",
      member: "RED",
      value: { tag: "int", value: 1n },
    },
  ],
  [
    "record dataclass",
    {
      tag: "record",
      type: "dataclass",
      name: "Point",
      fields: [
        { name: "x", value: { tag: "int", value: 1n } },
        { name: "y", value: { tag: "int", value: 2n } },
      ],
    },
  ],
  [
    "exception no details",
    { tag: "exception", type: "ValueError", message: "bad", details: null },
  ],
  [
    "exception with details",
    {
      tag: "exception",
      type: "KeyError",
      message: "missing",
      details: { tag: "str", value: "k" },
    },
  ],
  [
    "ListNode acyclic",
    {
      tag: "ListNode",
      values: [
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
      ],
      cycleIndex: null,
    },
  ],
  [
    "ListNode cyclic",
    {
      tag: "ListNode",
      values: [{ tag: "int", value: 1n }],
      cycleIndex: 0,
    },
  ],
  [
    "TreeNode",
    {
      tag: "TreeNode",
      values: [
        { tag: "int", value: 1n },
        null,
        { tag: "int", value: 2n },
      ],
    },
  ],
  [
    "ClassTrace",
    {
      tag: "ClassTrace",
      className: "LRUCache",
      constructor: [{ tag: "int", value: 2n }],
      operations: [
        {
          method: "put",
          args: [
            { tag: "int", value: 1n },
            { tag: "int", value: 10n },
          ],
        },
        {
          method: "get",
          args: [{ tag: "int", value: 1n }],
          expected: { tag: "int", value: 10n },
        },
      ],
    },
  ],
];

describe("tagged-jsonl-v1 round-trip", () => {
  it.each(cases)("round-trips %s", (_name, value) => {
    expect(roundTrip(value)).toEqual(value);
  });

  it.each(cases)("encodes %s deterministically", (_name, value) => {
    const a = codec.encode(value);
    const b = codec.encode(value);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("codec identity", () => {
  it("exposes the bound backend id and version", () => {
    expect(codec.backendId).toBe("test-backend");
    expect(codec.version).toBe("tagged-jsonl-v1");
  });
});
