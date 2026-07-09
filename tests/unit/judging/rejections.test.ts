/**
 * Rejection tests: one case per documented failure class. `decode` must never
 * throw — every malformed or non-canonical input becomes `{ ok: false }`.
 * Invalid in-memory values fail fast on `encode` instead.
 */

import { describe, it, expect } from "vitest";
import {
  createTaggedJsonlV1Codec,
  MAX_PAYLOAD_BYTES,
} from "../../../src/judging/codec/index.js";
import type { CanonicalValue } from "../../../src/judging/value/index.js";

const codec = createTaggedJsonlV1Codec("test-backend");

/** Decode JSON text, returning the discriminated result. */
function decode(json: string): ReturnType<typeof codec.decode> {
  return codec.decode(new TextEncoder().encode(json));
}

/** Assert a JSON text decodes to a failure. */
function rejects(json: string): void {
  const result = decode(json);
  expect(result.ok).toBe(false);
}

describe("decode rejections (classified protocol_error)", () => {
  it("rejects an unknown tag", () => {
    rejects('{"tag":"bogus"}');
  });

  it("rejects duplicate object keys", () => {
    rejects('{"tag":"null","tag":"null"}');
  });

  it("rejects a forbidden extra field", () => {
    rejects('{"tag":"null","extra":1}');
  });

  it("rejects a missing required field", () => {
    rejects('{"tag":"bool"}');
  });

  it("rejects a boolean value that is an integer (bool != int)", () => {
    rejects('{"tag":"bool","value":1}');
  });

  it("rejects invalid UTF-8 bytes", () => {
    const result = codec.decode(new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(result.ok).toBe(false);
  });

  it("rejects a lone UTF-16 surrogate in a string", () => {
    rejects('{"tag":"str","value":"\\ud800"}');
  });

  it("rejects malformed base64url", () => {
    rejects('{"tag":"bytes","encoding":"base64url","value":"!!!"}');
  });

  it("rejects an invalid calendar date", () => {
    rejects('{"tag":"date","value":"2026-13-40"}');
  });

  it("rejects a non-canonical (unsorted) set", () => {
    rejects(
      '{"tag":"set","items":[{"tag":"int","value":2},{"tag":"int","value":1}]}',
    );
  });

  it("rejects a duplicate set member", () => {
    rejects(
      '{"tag":"set","items":[{"tag":"int","value":1},{"tag":"int","value":1}]}',
    );
  });

  it("rejects an out-of-range int carried as a bare number", () => {
    rejects('{"tag":"int","value":9007199254740992}');
  });

  it("rejects a safe-range int carried as a string", () => {
    rejects('{"tag":"int","value":"42"}');
  });

  it("rejects a non-canonical float (leading zero)", () => {
    rejects('{"tag":"float","value":"01.5","negativeZero":false}');
  });

  it("rejects a TreeNode with trailing nulls", () => {
    rejects('{"tag":"TreeNode","values":[{"tag":"int","value":1},null]}');
  });

  it("rejects a TreeNode with an unreachable node", () => {
    rejects(
      '{"tag":"TreeNode","values":[null,{"tag":"int","value":1},null]}',
    );
  });

  it("rejects a ListNode cycleIndex out of range", () => {
    rejects('{"tag":"ListNode","values":[{"tag":"int","value":1}],"cycleIndex":5}');
  });

  it("rejects nesting deeper than the depth limit", () => {
    let json = '{"tag":"null"}';
    for (let i = 0; i < 300; i += 1) {
      json = `{"tag":"list","items":[${json}]}`;
    }
    rejects(json);
  });

  it("rejects a value graph exceeding the node limit", () => {
    const items = new Array(1_000_001).fill('{"tag":"null"}').join(",");
    rejects(`{"tag":"list","items":[${items}]}`);
  });

  it("rejects a payload larger than the size limit", () => {
    const result = codec.decode(new Uint8Array(MAX_PAYLOAD_BYTES + 1));
    expect(result.ok).toBe(false);
  });
});

describe("encode rejections (throw CodecEncodeError)", () => {
  it("throws on a non-finite float (NaN)", () => {
    expect(() =>
      codec.encode({ tag: "float", value: "NaN", negativeZero: false }),
    ).toThrow();
  });

  it("throws on Infinity encoded as a float", () => {
    expect(() =>
      codec.encode({ tag: "float", value: "Infinity", negativeZero: false }),
    ).toThrow();
  });

  it("throws on an absolute path", () => {
    expect(() =>
      codec.encode({ tag: "path", value: "/etc/passwd", flavor: "posix" }),
    ).toThrow();
  });

  it("throws on a reference cycle", () => {
    const items: CanonicalValue[] = [];
    const cyclic: CanonicalValue = { tag: "list", items };
    items.push(cyclic);
    expect(() => codec.encode(cyclic)).toThrow();
  });

  it("throws on a duplicate dict key in memory", () => {
    expect(() =>
      codec.encode({
        tag: "dict",
        entries: [
          { key: { tag: "int", value: 1n }, value: { tag: "null" } },
          { key: { tag: "int", value: 1n }, value: { tag: "null" } },
        ],
      }),
    ).toThrow();
  });
});
