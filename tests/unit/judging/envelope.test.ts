/**
 * Envelope framing validation matrix for the JSON Lines request/response
 * protocol. Every framing or validation failure must be reported as a
 * `protocol_error` result; well-formed envelopes must round-trip.
 */

import { describe, it, expect } from "vitest";
import {
  decodeRequestLine,
  decodeResponseLine,
  encodeRequestLine,
  encodeResponseLine,
  MAX_PAYLOAD_BYTES,
} from "../../../src/judging/codec/index.js";
import type {
  ExpectedResponse,
  RequestEnvelope,
  ResponseEnvelope,
} from "../../../src/judging/codec/index.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const expected: ExpectedResponse = {
  runId: "r1",
  caseId: "c1",
  codecVersion: "tagged-jsonl-v1",
};

const VALID_REQUEST =
  '{"protocolVersion":1,"kind":"request","runId":"r1","caseId":"c1",' +
  '"codecVersion":"tagged-jsonl-v1","messageLimitBytes":1000000,' +
  '"input":{"tag":"null"}}';

const VALID_RESPONSE =
  '{"protocolVersion":1,"kind":"response","runId":"r1","caseId":"c1",' +
  '"codecVersion":"tagged-jsonl-v1","messageLimitBytes":1000000,' +
  '"output":{"tag":"int","value":42},"exception":null}';

describe("request round-trip", () => {
  it("encodes then decodes a request", () => {
    const env: RequestEnvelope = {
      protocolVersion: 1,
      kind: "request",
      runId: "r1",
      caseId: "c1",
      codecVersion: "tagged-jsonl-v1",
      messageLimitBytes: 1_000_000,
      input: { tag: "str", value: "hello" },
    };
    const line = encodeRequestLine(env);
    expect(line[line.length - 1]).toBe(0x0a); // trailing newline
    const result = decodeRequestLine(line);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.input).toEqual({ tag: "str", value: "hello" });
      expect(result.envelope.runId).toBe("r1");
    }
  });

  it("accepts a valid literal request line", () => {
    expect(decodeRequestLine(bytes(VALID_REQUEST)).ok).toBe(true);
    expect(decodeRequestLine(bytes(`${VALID_REQUEST}\n`)).ok).toBe(true);
  });
});

describe("response round-trip", () => {
  it("encodes then decodes a response carrying output", () => {
    const env: ResponseEnvelope = {
      protocolVersion: 1,
      kind: "response",
      runId: "r1",
      caseId: "c1",
      codecVersion: "tagged-jsonl-v1",
      messageLimitBytes: 1_000_000,
      output: { tag: "int", value: 42n },
      exception: null,
    };
    const result = decodeResponseLine(encodeResponseLine(env), expected);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.output).toEqual({ tag: "int", value: 42n });
      expect(result.envelope.exception).toBeNull();
    }
  });

  it("encodes then decodes a response carrying an exception", () => {
    const env: ResponseEnvelope = {
      protocolVersion: 1,
      kind: "response",
      runId: "r1",
      caseId: "c1",
      codecVersion: "tagged-jsonl-v1",
      messageLimitBytes: 1_000_000,
      output: null,
      exception: {
        tag: "exception",
        type: "ValueError",
        message: "boom",
        details: null,
      },
    };
    const result = decodeResponseLine(encodeResponseLine(env), expected);
    expect(result.ok).toBe(true);
    if (result.ok && result.envelope.exception !== null) {
      expect(result.envelope.exception.type).toBe("ValueError");
    }
  });
});

describe("framing rejections", () => {
  it("rejects more than one line", () => {
    expect(
      decodeRequestLine(bytes(`${VALID_REQUEST}\n${VALID_REQUEST}`)).ok,
    ).toBe(false);
  });

  it("rejects an empty line", () => {
    expect(decodeRequestLine(bytes("")).ok).toBe(false);
  });

  it("rejects a missing field", () => {
    const line = VALID_REQUEST.replace(',"input":{"tag":"null"}', "");
    expect(decodeRequestLine(bytes(line)).ok).toBe(false);
  });

  it("rejects a duplicate field", () => {
    const line = VALID_REQUEST.replace(
      '"runId":"r1",',
      '"runId":"r1","runId":"r1",',
    );
    expect(decodeRequestLine(bytes(line)).ok).toBe(false);
  });

  it("rejects an unknown field", () => {
    const line = VALID_REQUEST.replace("}", ',"surprise":true}');
    expect(decodeRequestLine(bytes(line)).ok).toBe(false);
  });

  it("rejects an unsupported protocolVersion", () => {
    const line = VALID_REQUEST.replace(
      '"protocolVersion":1',
      '"protocolVersion":2',
    );
    expect(decodeRequestLine(bytes(line)).ok).toBe(false);
  });

  it("rejects an unsupported codec version", () => {
    const line = VALID_REQUEST.replace("tagged-jsonl-v1", "tagged-jsonl-v9");
    expect(decodeRequestLine(bytes(line)).ok).toBe(false);
  });

  it("rejects the wrong kind", () => {
    expect(decodeRequestLine(bytes(VALID_RESPONSE)).ok).toBe(false);
  });

  it("rejects a message larger than messageLimitBytes", () => {
    const line = VALID_REQUEST.replace("1000000", "5");
    expect(decodeRequestLine(bytes(line)).ok).toBe(false);
  });

  it("rejects a messageLimitBytes over the payload cap", () => {
    const line = VALID_REQUEST.replace(
      '"messageLimitBytes":1000000',
      `"messageLimitBytes":${MAX_PAYLOAD_BYTES + 1}`,
    );
    expect(decodeRequestLine(bytes(line)).ok).toBe(false);
  });
});

describe("response-specific rejections", () => {
  it("rejects a mismatched runId", () => {
    const line = VALID_RESPONSE.replace('"runId":"r1"', '"runId":"rX"');
    expect(decodeResponseLine(bytes(line), expected).ok).toBe(false);
  });

  it("rejects a response carrying both output and exception", () => {
    const line = VALID_RESPONSE.replace(
      '"exception":null',
      '"exception":{"tag":"exception","type":"E","message":"m","details":null}',
    );
    expect(decodeResponseLine(bytes(line), expected).ok).toBe(false);
  });

  it("rejects a response carrying neither output nor exception", () => {
    const line = VALID_RESPONSE.replace(
      '"output":{"tag":"int","value":42}',
      '"output":null',
    );
    expect(decodeResponseLine(bytes(line), expected).ok).toBe(false);
  });

  it("rejects an exception field that is not an exception value", () => {
    const line = VALID_RESPONSE.replace(
      '"output":{"tag":"int","value":42},"exception":null',
      '"output":null,"exception":{"tag":"int","value":1}',
    );
    expect(decodeResponseLine(bytes(line), expected).ok).toBe(false);
  });
});

describe("encode-side validation", () => {
  it("throws when a response sets both output and exception", () => {
    expect(() =>
      encodeResponseLine({
        protocolVersion: 1,
        kind: "response",
        runId: "r1",
        caseId: "c1",
        codecVersion: "tagged-jsonl-v1",
        messageLimitBytes: 1_000_000,
        output: { tag: "null" },
        exception: {
          tag: "exception",
          type: "E",
          message: "m",
          details: null,
        },
      }),
    ).toThrow();
  });

  it("throws on a non-positive messageLimitBytes", () => {
    expect(() =>
      encodeRequestLine({
        protocolVersion: 1,
        kind: "request",
        runId: "r1",
        caseId: "c1",
        codecVersion: "tagged-jsonl-v1",
        messageLimitBytes: 0,
        input: { tag: "null" },
      }),
    ).toThrow();
  });
});
