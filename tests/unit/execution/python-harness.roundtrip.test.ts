/**
 * End-to-end round-trip tests for the shipped Python harness.
 *
 * Each case encodes a request line with the authoritative TypeScript codec,
 * spawns the harness with the host `python3`, and decodes the harness's single
 * stdout line back with the TypeScript codec. A value that survives this
 * TS -> Python -> TS trip unchanged proves the Python codec mirror is
 * byte-compatible with the TypeScript one. The suite skips (with a reason) when
 * `python3` is unavailable.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  CODEC_VERSION,
  encodeRequestLine,
  decodeResponseLine,
} from "../../../src/judging/codec/index.js";
import type {
  CanonicalValue,
  ExpectedResponse,
  RequestEnvelope,
} from "../../../src/judging/codec/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const HARNESS = path.join(
  REPO_ROOT,
  "src/execution/runtimes/python/harness/__main__.py",
);
const ECHO_IMPL = "tests/fixtures/python/echo.py";
const LRU_IMPL = "tests/fixtures/python/lru.py";

/** Whether a runnable `python3` is present on this host. */
const PYTHON_AVAILABLE = spawnSync("python3", ["--version"]).status === 0;

const RUN_ID = "run-roundtrip";
const CASE_ID = "case-1";
const EXPECTED: ExpectedResponse = {
  runId: RUN_ID,
  caseId: CASE_ID,
  codecVersion: CODEC_VERSION,
};

/** Build a request envelope carrying `input`. */
function request(input: CanonicalValue): RequestEnvelope {
  return {
    protocolVersion: 1,
    kind: "request",
    runId: RUN_ID,
    caseId: CASE_ID,
    codecVersion: CODEC_VERSION,
    messageLimitBytes: 1_000_000,
    input,
  };
}

/** Spawn the harness for one request and return its raw process result. */
function runHarness(
  role: string,
  impl: string,
  entry: string,
  requestBytes: Uint8Array,
): { status: number | null; stdout: Buffer; stderr: Buffer } {
  const result = spawnSync(
    "python3",
    [HARNESS, "--role", role, "--impl", impl, "--entry", entry],
    { cwd: REPO_ROOT, input: Buffer.from(requestBytes) },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Encode `input`, run `echo.solve`, and decode the resulting output value. */
function echoRoundTrip(input: CanonicalValue): CanonicalValue {
  const { status, stdout, stderr } = runHarness(
    "solution",
    ECHO_IMPL,
    "solve",
    encodeRequestLine(request(input)),
  );
  expect(status, `harness stderr: ${stderr.toString("utf8")}`).toBe(0);
  const decoded = decodeResponseLine(new Uint8Array(stdout), EXPECTED);
  if (!decoded.ok) {
    throw new Error(`response decode failed: ${decoded.error.message}`);
  }
  expect(decoded.envelope.exception).toBeNull();
  if (decoded.envelope.output === null) {
    throw new Error("expected an output value, got null");
  }
  return decoded.envelope.output;
}

describe.skipIf(!PYTHON_AVAILABLE)("python harness round-trip", () => {
  it("round-trips a rich scalar/container value", () => {
    const value: CanonicalValue = {
      tag: "list",
      items: [
        { tag: "int", value: 1n },
        { tag: "str", value: "héllo" },
        { tag: "float", value: "1.5", negativeZero: false },
        { tag: "bool", value: true },
        { tag: "null" },
        { tag: "bytes", encoding: "base64url", value: "AQID" },
      ],
    };
    expect(echoRoundTrip(value)).toEqual(value);
  });

  it("round-trips a ListNode adapter value", () => {
    const value: CanonicalValue = {
      tag: "ListNode",
      values: [
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
        { tag: "int", value: 3n },
      ],
      cycleIndex: null,
    };
    expect(echoRoundTrip(value)).toEqual(value);
  });

  it("round-trips a TreeNode adapter value", () => {
    const value: CanonicalValue = {
      tag: "TreeNode",
      values: [
        { tag: "int", value: 1n },
        { tag: "int", value: 2n },
        { tag: "int", value: 3n },
        null,
        { tag: "int", value: 4n },
      ],
    };
    expect(echoRoundTrip(value)).toEqual(value);
  });

  it("drives an LRUCache ClassTrace and returns one value per operation", () => {
    const trace: CanonicalValue = {
      tag: "ClassTrace",
      className: "LRUCache",
      constructor: [{ tag: "int", value: 2n }],
      operations: [
        { method: "put", args: [{ tag: "int", value: 1n }, { tag: "int", value: 1n }] },
        { method: "put", args: [{ tag: "int", value: 2n }, { tag: "int", value: 2n }] },
        { method: "get", args: [{ tag: "int", value: 1n }] },
        { method: "put", args: [{ tag: "int", value: 3n }, { tag: "int", value: 3n }] },
        { method: "get", args: [{ tag: "int", value: 2n }] },
      ],
    };
    const { status, stdout, stderr } = runHarness(
      "solution",
      LRU_IMPL,
      "solve",
      encodeRequestLine(request(trace)),
    );
    expect(status, `harness stderr: ${stderr.toString("utf8")}`).toBe(0);
    const decoded = decodeResponseLine(new Uint8Array(stdout), EXPECTED);
    if (!decoded.ok) {
      throw new Error(`response decode failed: ${decoded.error.message}`);
    }
    expect(decoded.envelope.output).toEqual({
      tag: "list",
      items: [
        { tag: "null" },
        { tag: "null" },
        { tag: "int", value: 1n },
        { tag: "null" },
        { tag: "int", value: -1n },
      ],
    });
  });

  it("returns a canonical exception value when the target raises", () => {
    const output = runHarness(
      "solution",
      "tests/fixtures/python/raises.py",
      "solve",
      encodeRequestLine(request({ tag: "null" })),
    );
    expect(output.status, `harness stderr: ${output.stderr.toString("utf8")}`).toBe(0);
    const decoded = decodeResponseLine(new Uint8Array(output.stdout), EXPECTED);
    if (!decoded.ok) {
      throw new Error(`response decode failed: ${decoded.error.message}`);
    }
    expect(decoded.envelope.output).toBeNull();
    expect(decoded.envelope.exception?.tag).toBe("exception");
    expect(decoded.envelope.exception?.type).toBe("ValueError");
  });

  it("exits nonzero with no valid response on a malformed request", () => {
    const { status, stdout } = runHarness(
      "solution",
      ECHO_IMPL,
      "solve",
      new TextEncoder().encode("this is not a valid request line\n"),
    );
    expect(status).not.toBe(0);
    const decoded = decodeResponseLine(new Uint8Array(stdout), EXPECTED);
    expect(decoded.ok).toBe(false);
  });
});
