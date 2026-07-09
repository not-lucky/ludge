/**
 * Contract-test scaffold for the judging ports.
 *
 * These suites enumerate the obligations any concrete {@link Codec} and
 * {@link OutputComparator} must satisfy. They are `todo` placeholders: task 04
 * (canonical codec) and task 05 (comparators) supply fixtures that drive these
 * obligations against real implementations.
 */

import { describe, it, expect } from "vitest";
import type {
  Codec,
  DecodeResult,
  OutputComparator,
} from "../../src/judging/ports/index.js";
import { createTaggedJsonlV1Codec } from "../../src/judging/codec/index.js";
import type { CanonicalValue } from "../../src/judging/value/index.js";

// Retain the type-only imports and verify the port surface exists.
type _PortSurface = [
  Codec<unknown>,
  DecodeResult<unknown>,
  OutputComparator<unknown>,
];

describe("Codec contract", () => {
  const codec: Codec<CanonicalValue> = createTaggedJsonlV1Codec("backend");

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

describe("OutputComparator contract", () => {
  it.todo("compare() reports equality for structurally equal values");
  it.todo("compare() returns the first mismatch path for unequal values");
  it.todo("compare() honors numeric tolerance only on finite numeric leaves");
  it.todo("compare() applies whitespace normalization only for text outputs");
});
