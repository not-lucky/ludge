/** Direct tagged-JSONL codec and exact-comparator behavior. */

import { describe, it, expect } from "vitest";
import {
  createTaggedJsonlV1Codec,
  type VersionedCodec,
} from "../../src/judging/codec/tagged-jsonl-v1.js";
import { createOutputComparator } from "../../src/judging/comparator/index.js";
import type { CanonicalValue } from "../../src/judging/value/model.js";
import type { ComparisonPolicy } from "../../src/domain/comparison.js";

describe("tagged JSONL codec", () => {
  const codec: VersionedCodec<CanonicalValue> = createTaggedJsonlV1Codec();

  it("encode() then decode() round-trips a canonical value exactly", () => {
    const value: CanonicalValue = {
      tag: "dict",
      entries: [
        {
          key: { tag: "str", value: "n" },
          value: { tag: "int", value: 5n },
        },
      ],
    };
    const result = codec.decode(codec.encode(value));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(value);
    }
  });

  it("decode() returns { ok: false } (never throws) on malformed bytes", () => {
    const result = codec.decode(new TextEncoder().encode("{not json"));
    expect(result.ok).toBe(false);
  });

  it("decode() rejects inputs that exceed depth/node/size limits", () => {
    let json = '{"tag":"null"}';
    for (let i = 0; i < 300; i += 1) {
      json = `{"tag":"list","items":[${json}]}`;
    }
    expect(codec.decode(new TextEncoder().encode(json)).ok).toBe(false);
  });

  it("decode() rejects unknown tags, duplicate keys, and invalid UTF-8", () => {
    expect(codec.decode(new TextEncoder().encode('{"tag":"nope"}')).ok).toBe(
      false,
    );
    expect(
      codec.decode(new TextEncoder().encode('{"tag":"null","tag":"null"}')).ok,
    ).toBe(false);
    expect(codec.decode(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
  });
});

describe("exact output comparator", () => {
  const comparator = createOutputComparator();
  const semantic: ComparisonPolicy = {
    version: "exact-v1",
    equality: "semantic",
    normalizeWhitespace: false,
  };

  it("compare() reports equality for structurally equal values", () => {
    const value: CanonicalValue = {
      tag: "list",
      items: [
        { tag: "int", value: 1n },
        { tag: "str", value: "x" },
      ],
    };
    expect(comparator.compare(value, value, semantic)).toEqual({ equal: true });
  });

  it("compare() returns the first mismatch path for unequal values", () => {
    const expected: CanonicalValue = {
      tag: "list",
      items: [
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
      ],
    };
    const actual: CanonicalValue = {
      tag: "list",
      items: [
        { tag: "int", value: 1n },
        { tag: "int", value: 9n },
      ],
    };
    const result = comparator.compare(expected, actual, semantic);
    expect(result.equal).toBe(false);
    if (!result.equal) {
      expect(result.mismatch.path).toBe("$.items[1]");
    }
  });

  it("compare() honors numeric tolerance only on finite numeric leaves", () => {
    const tolerant: ComparisonPolicy = {
      version: "exact-v1",
      equality: "semantic",
      normalizeWhitespace: false,
      tolerance: { absolute: 0.01, relative: 0 },
    };
    const near: CanonicalValue = {
      tag: "float",
      value: "1.005",
      negativeZero: false,
    };
    const base: CanonicalValue = {
      tag: "float",
      value: "1",
      negativeZero: false,
    };
    expect(comparator.compare(base, near, tolerant)).toEqual({ equal: true });

    // The same tolerance must not relax integers.
    const intResult = comparator.compare(
      { tag: "int", value: 1n },
      { tag: "int", value: 2n },
      tolerant,
    );
    expect(intResult.equal).toBe(false);
  });

  it("compare() applies whitespace normalization only for text outputs", () => {
    const normalizing: ComparisonPolicy = {
      version: "exact-v1",
      equality: "semantic",
      normalizeWhitespace: true,
    };
    expect(
      comparator.compare(
        { tag: "str", value: "a  b" },
        { tag: "str", value: "a b" },
        normalizing,
      ),
    ).toEqual({ equal: true });
  });

  it("compare() rejects an unsupported comparator major version", () => {
    expect(() =>
      comparator.compare(
        { tag: "null" },
        { tag: "null" },
        {
          version: "exact-v2",
          equality: "semantic",
          normalizeWhitespace: false,
        },
      ),
    ).toThrow();
  });
});
