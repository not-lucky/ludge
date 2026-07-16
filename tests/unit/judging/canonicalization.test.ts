/**
 * Canonicalization tests: the encoder must produce one and only one byte form
 * for equal values, regardless of input ordering.
 */

import { describe, it, expect } from "vitest";
import { createTaggedJsonlV1Codec } from "../../../src/judging/codec/index.js";
import type { CanonicalValue } from "../../../src/judging/value/model.js";

const codec = createTaggedJsonlV1Codec("test-backend");

/** Encode a value to its canonical JSON text. */
function text(value: CanonicalValue): string {
  return new TextDecoder().decode(codec.encode(value));
}

describe("object key ordering", () => {
  it("emits object keys in UTF-8 lexical order", () => {
    // For float the keys sort negativeZero < tag < value.
    expect(text({ tag: "float", value: "1.5", negativeZero: false })).toBe(
      '{"negativeZero":false,"tag":"float","value":"1.5"}',
    );
    // For path the keys sort flavor < tag < value.
    expect(text({ tag: "path", value: "a/b", flavor: "posix" })).toBe(
      '{"flavor":"posix","tag":"path","value":"a/b"}',
    );
  });
});

describe("set / frozenset canonicalization", () => {
  it("sorts set items by canonical bytes regardless of input order", () => {
    const ascending: CanonicalValue = {
      tag: "set",
      items: [
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
        { tag: "int", value: 3n },
      ],
    };
    const shuffled: CanonicalValue = {
      tag: "set",
      items: [
        { tag: "int", value: 3n },
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
      ],
    };
    expect(text(shuffled)).toBe(text(ascending));
  });

  it("produces identical bytes for a frozenset in any order", () => {
    const a: CanonicalValue = {
      tag: "frozenset",
      items: [
        { tag: "str", value: "b" },
        { tag: "str", value: "a" },
      ],
    };
    const b: CanonicalValue = {
      tag: "frozenset",
      items: [
        { tag: "str", value: "a" },
        { tag: "str", value: "b" },
      ],
    };
    expect(text(a)).toBe(text(b));
  });
});

describe("dict canonicalization", () => {
  it("sorts dict entries by canonical key bytes", () => {
    const forward: CanonicalValue = {
      tag: "dict",
      entries: [
        { key: { tag: "int", value: 1n }, value: { tag: "str", value: "a" } },
        { key: { tag: "int", value: 2n }, value: { tag: "str", value: "b" } },
      ],
    };
    const reversed: CanonicalValue = {
      tag: "dict",
      entries: [
        { key: { tag: "int", value: 2n }, value: { tag: "str", value: "b" } },
        { key: { tag: "int", value: 1n }, value: { tag: "str", value: "a" } },
      ],
    };
    expect(text(reversed)).toBe(text(forward));
  });
});

describe("float negative zero", () => {
  it('carries -0.0 as value "0" with negativeZero true', () => {
    expect(text({ tag: "float", value: "0", negativeZero: true })).toBe(
      '{"negativeZero":true,"tag":"float","value":"0"}',
    );
  });
});

describe("int representation boundary", () => {
  it("emits a bare number at the safe-integer edge", () => {
    expect(text({ tag: "int", value: 9_007_199_254_740_991n })).toBe(
      '{"tag":"int","value":9007199254740991}',
    );
  });

  it("emits a decimal string just past the safe-integer edge", () => {
    expect(text({ tag: "int", value: 9_007_199_254_740_992n })).toBe(
      '{"tag":"int","value":"9007199254740992"}',
    );
  });
});

describe("TreeNode trailing-null stripping", () => {
  it("removes trailing null slots from the canonical form", () => {
    const value: CanonicalValue = {
      tag: "TreeNode",
      values: [{ tag: "int", value: 1n }, null, null],
    };
    expect(text(value)).toBe(
      '{"tag":"TreeNode","values":[{"tag":"int","value":1}]}',
    );
    const decoded = codec.decode(codec.encode(value));
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.value.tag === "TreeNode") {
      expect(decoded.value.values).toEqual([{ tag: "int", value: 1n }]);
    }
  });
});
