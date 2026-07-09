/**
 * JSON Lines request/response envelope framing.
 *
 * The transport carries exactly one request line on stdin (then EOF) and
 * exactly one response line on stdout (then EOF). Each line is a single JSON
 * object with `protocolVersion: 1`, framing metadata, and a canonical value
 * payload. This module encodes envelopes to bytes and decodes bytes to
 * validated envelopes.
 *
 * Ordering of the two limits matters and is honored here: the envelope's
 * `messageLimitBytes` is checked against the raw message BEFORE the value
 * payload is decoded, while the codec's 16 MiB payload limit is enforced by the
 * value builder afterward. Any framing or validation failure is a
 * `protocol_error`; stderr is never parsed as protocol data (not this module's
 * concern).
 */

import type { CanonicalValue } from "../value/model.js";
import { Budget, MAX_PAYLOAD_BYTES } from "./limits.js";
import { CodecEncodeError, CanonicalValidationError } from "./errors.js";
import { encodeValue } from "./encode.js";
import { buildValue } from "./decode.js";
import { parseJson } from "./json.js";
import type { JsonNode } from "./json.js";
import { decodeUtf8Fatal, encodeUtf8 } from "./utf8.js";
import { isSupportedCodecVersion } from "./tagged-jsonl-v1.js";

/** The only protocol version this build produces and accepts. */
export const PROTOCOL_VERSION = 1;

/** The canonical `exception` value carried by a failing response. */
type ExceptionValue = Extract<CanonicalValue, { tag: "exception" }>;

/**
 * A decoded request envelope: framing metadata plus one canonical input value.
 */
export interface RequestEnvelope {
  readonly protocolVersion: 1;
  readonly kind: "request";
  readonly runId: string;
  readonly caseId: string;
  readonly codecVersion: string;
  readonly messageLimitBytes: number;
  readonly input: CanonicalValue;
}

/**
 * A decoded response envelope with exactly one of `output`/`exception` set.
 *
 * When the target produced a value, `output` is that value and `exception` is
 * `null`; when it raised, `exception` is the canonical exception and `output`
 * is `null`.
 */
export interface ResponseEnvelope {
  readonly protocolVersion: 1;
  readonly kind: "response";
  readonly runId: string;
  readonly caseId: string;
  readonly codecVersion: string;
  readonly messageLimitBytes: number;
  readonly output: CanonicalValue | null;
  readonly exception: ExceptionValue | null;
}

/**
 * The identity a response is expected to echo, taken from the request.
 *
 * A response whose `runId`/`caseId`/`codecVersion` differ is a protocol error.
 */
export interface ExpectedResponse {
  readonly runId: string;
  readonly caseId: string;
  readonly codecVersion: string;
}

/**
 * A framing/validation failure. Every envelope failure is classified
 * `protocol_error`; `path` locates a payload fault when known.
 */
export interface EnvelopeError {
  readonly message: string;
  readonly category: "protocol_error";
  readonly path?: string;
}

/** The result of decoding an envelope line. */
export type EnvelopeDecodeResult<T> =
  | { readonly ok: true; readonly envelope: T }
  | { readonly ok: false; readonly error: EnvelopeError };

/** Internal control-flow signal carrying a protocol rejection. */
class EnvelopeReject extends Error {
  public constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

// --- encoding ---------------------------------------------------------------

/**
 * Encode a request envelope to a single newline-terminated JSON Lines record.
 *
 * @param env - The request envelope to encode.
 * @returns The UTF-8 bytes of the framed line (including the trailing newline).
 * @throws {CodecEncodeError} If framing metadata or the input value is invalid.
 */
export function encodeRequestLine(env: RequestEnvelope): Uint8Array {
  validateFramingForEncode(env.runId, env.caseId, env.codecVersion, env.messageLimitBytes);
  const line = objectText([
    ["caseId", jsonString(env.caseId)],
    ["codecVersion", jsonString(env.codecVersion)],
    ["input", encodeValue(env.input, new Budget())],
    ["kind", '"request"'],
    ["messageLimitBytes", String(env.messageLimitBytes)],
    ["protocolVersion", String(PROTOCOL_VERSION)],
    ["runId", jsonString(env.runId)],
  ]);
  return encodeUtf8(`${line}\n`);
}

/**
 * Encode a response envelope to a single newline-terminated JSON Lines record.
 *
 * @param env - The response envelope to encode.
 * @returns The UTF-8 bytes of the framed line (including the trailing newline).
 * @throws {CodecEncodeError} If framing metadata or the payload is invalid.
 */
export function encodeResponseLine(env: ResponseEnvelope): Uint8Array {
  validateFramingForEncode(env.runId, env.caseId, env.codecVersion, env.messageLimitBytes);
  const hasOutput = env.output !== null;
  const hasException = env.exception !== null;
  if (hasOutput === hasException) {
    throw new CodecEncodeError(
      "response must carry exactly one of output/exception",
    );
  }
  const line = objectText([
    ["caseId", jsonString(env.caseId)],
    ["codecVersion", jsonString(env.codecVersion)],
    ["exception", env.exception === null ? "null" : encodeValue(env.exception, new Budget())],
    ["kind", '"response"'],
    ["messageLimitBytes", String(env.messageLimitBytes)],
    ["output", env.output === null ? "null" : encodeValue(env.output, new Budget())],
    ["protocolVersion", String(PROTOCOL_VERSION)],
    ["runId", jsonString(env.runId)],
  ]);
  return encodeUtf8(`${line}\n`);
}

// --- decoding ---------------------------------------------------------------

/**
 * Decode and validate a request envelope from a framed line.
 *
 * @param bytes - The raw message bytes (one line, optional trailing newline).
 * @returns The decoded request, or a protocol-error result.
 */
export function decodeRequestLine(
  bytes: Uint8Array,
): EnvelopeDecodeResult<RequestEnvelope> {
  try {
    const members = frameToObject(bytes);
    requireProtocolVersion(members);
    requireKind(members, "request");
    const messageLimitBytes = readMessageLimit(members, bytes.length);
    const runId = nonEmptyString(members, "runId");
    const caseId = nonEmptyString(members, "caseId");
    const codecVersion = nonEmptyString(members, "codecVersion");
    if (!isSupportedCodecVersion(codecVersion)) {
      throw new EnvelopeReject("unsupported codec version");
    }
    exactFields(members, [
      "caseId",
      "codecVersion",
      "input",
      "kind",
      "messageLimitBytes",
      "protocolVersion",
      "runId",
    ]);
    const input = buildOrReject(requireMember(members, "input"), "$.input");
    return {
      ok: true,
      envelope: {
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        runId,
        caseId,
        codecVersion,
        messageLimitBytes,
        input,
      },
    };
  } catch (err) {
    return toErrorResult(err);
  }
}

/**
 * Decode and validate a response envelope, checking it echoes `expected`.
 *
 * @param bytes - The raw message bytes (one line, optional trailing newline).
 * @param expected - The identity the response must match.
 * @returns The decoded response, or a protocol-error result.
 */
export function decodeResponseLine(
  bytes: Uint8Array,
  expected: ExpectedResponse,
): EnvelopeDecodeResult<ResponseEnvelope> {
  try {
    const members = frameToObject(bytes);
    requireProtocolVersion(members);
    requireKind(members, "response");
    const messageLimitBytes = readMessageLimit(members, bytes.length);
    const runId = nonEmptyString(members, "runId");
    const caseId = nonEmptyString(members, "caseId");
    const codecVersion = nonEmptyString(members, "codecVersion");
    matchExpected(runId, expected.runId, "runId");
    matchExpected(caseId, expected.caseId, "caseId");
    matchExpected(codecVersion, expected.codecVersion, "codecVersion");
    exactFields(members, [
      "caseId",
      "codecVersion",
      "exception",
      "kind",
      "messageLimitBytes",
      "output",
      "protocolVersion",
      "runId",
    ]);
    const outputNode = requireMember(members, "output");
    const exceptionNode = requireMember(members, "exception");
    const hasOutput = outputNode.kind !== "null";
    const hasException = exceptionNode.kind !== "null";
    if (hasOutput === hasException) {
      throw new EnvelopeReject(
        "response must carry exactly one of output/exception",
      );
    }
    const output = hasOutput ? buildOrReject(outputNode, "$.output") : null;
    const exception = hasException
      ? buildException(exceptionNode)
      : null;
    return {
      ok: true,
      envelope: {
        protocolVersion: PROTOCOL_VERSION,
        kind: "response",
        runId,
        caseId,
        codecVersion,
        messageLimitBytes,
        output,
        exception,
      },
    };
  } catch (err) {
    return toErrorResult(err);
  }
}

// --- shared framing helpers -------------------------------------------------

/** Decode bytes, extract the single line, parse it, and require an object. */
function frameToObject(bytes: Uint8Array): ReadonlyMap<string, JsonNode> {
  let text: string;
  try {
    text = decodeUtf8Fatal(bytes);
  } catch {
    throw new EnvelopeReject("message is not valid UTF-8");
  }
  const line = singleLine(text);
  const parsed = parseJson(line);
  if (!parsed.ok) {
    throw new EnvelopeReject(`malformed envelope JSON: ${parsed.error.message}`);
  }
  if (parsed.node.kind !== "object") {
    throw new EnvelopeReject("envelope must be a JSON object");
  }
  return parsed.node.members;
}

/**
 * Extract exactly one non-empty line, allowing a single optional trailing
 * newline. Any additional line (including an extra blank line) is a protocol
 * error, enforcing "exactly one complete line then EOF".
 */
function singleLine(text: string): string {
  const parts = text.split("\n");
  if (parts.length > 2 || (parts.length === 2 && parts[1] !== "")) {
    throw new EnvelopeReject("expected exactly one line then EOF");
  }
  const line = parts[0] ?? "";
  if (line.length === 0) {
    throw new EnvelopeReject("empty envelope line");
  }
  return line;
}

/** Require `protocolVersion` to be exactly the JSON number `1`. */
function requireProtocolVersion(members: ReadonlyMap<string, JsonNode>): void {
  const node = members.get("protocolVersion");
  if (node === undefined || node.kind !== "number") {
    throw new EnvelopeReject("missing protocolVersion");
  }
  if (node.raw !== String(PROTOCOL_VERSION)) {
    throw new EnvelopeReject(`unsupported protocolVersion ${node.raw}`);
  }
}

/** Require `kind` to equal the expected discriminant. */
function requireKind(
  members: ReadonlyMap<string, JsonNode>,
  kind: "request" | "response",
): void {
  const node = members.get("kind");
  if (node === undefined || node.kind !== "string" || node.value !== kind) {
    throw new EnvelopeReject(`kind must be ${JSON.stringify(kind)}`);
  }
}

/**
 * Read and validate `messageLimitBytes`, then enforce it against the raw
 * message length BEFORE the value payload is decoded.
 */
function readMessageLimit(
  members: ReadonlyMap<string, JsonNode>,
  messageBytes: number,
): number {
  const node = members.get("messageLimitBytes");
  if (node === undefined || node.kind !== "number" || !/^[1-9][0-9]*$/.test(node.raw)) {
    throw new EnvelopeReject("messageLimitBytes must be a positive integer");
  }
  const limit = Number(node.raw);
  if (limit > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeReject(
      `messageLimitBytes exceeds ${MAX_PAYLOAD_BYTES}`,
    );
  }
  if (messageBytes > limit) {
    throw new EnvelopeReject("message exceeds messageLimitBytes");
  }
  return limit;
}

/** Read a required, non-empty string framing field. */
function nonEmptyString(
  members: ReadonlyMap<string, JsonNode>,
  key: string,
): string {
  const node = members.get(key);
  if (node === undefined || node.kind !== "string" || node.value.length === 0) {
    throw new EnvelopeReject(`${key} must be a non-empty string`);
  }
  return node.value;
}

/** Reject a mismatch between a response field and the expected value. */
function matchExpected(actual: string, expected: string, key: string): void {
  if (actual !== expected) {
    throw new EnvelopeReject(`${key} does not match the request`);
  }
}

/** Reject any member outside `allowed`, and any missing required member. */
function exactFields(
  members: ReadonlyMap<string, JsonNode>,
  allowed: readonly string[],
): void {
  for (const key of members.keys()) {
    if (!allowed.includes(key)) {
      throw new EnvelopeReject(`unknown envelope field ${JSON.stringify(key)}`);
    }
  }
  for (const key of allowed) {
    if (!members.has(key)) {
      throw new EnvelopeReject(`missing envelope field ${JSON.stringify(key)}`);
    }
  }
}

/** Fetch a required member node. */
function requireMember(
  members: ReadonlyMap<string, JsonNode>,
  key: string,
): JsonNode {
  const node = members.get(key);
  if (node === undefined) {
    throw new EnvelopeReject(`missing envelope field ${JSON.stringify(key)}`);
  }
  return node;
}

/** Build a value payload, mapping a validation failure to a protocol error. */
function buildOrReject(node: JsonNode, path: string): CanonicalValue {
  try {
    return buildValue(node, new Budget());
  } catch (err) {
    if (err instanceof CanonicalValidationError) {
      throw new EnvelopeReject(err.message, err.path ?? path);
    }
    throw err;
  }
}

/** Build an exception payload, requiring the `exception` tag. */
function buildException(node: JsonNode): ExceptionValue {
  const value = buildOrReject(node, "$.exception");
  if (value.tag !== "exception") {
    throw new EnvelopeReject("response exception must be an exception value");
  }
  return value;
}

/** Convert a caught rejection into an error result; rethrow anything else. */
function toErrorResult<T>(err: unknown): EnvelopeDecodeResult<T> {
  if (err instanceof EnvelopeReject) {
    return err.path === undefined
      ? { ok: false, error: { message: err.message, category: "protocol_error" } }
      : {
          ok: false,
          error: { message: err.message, category: "protocol_error", path: err.path },
        };
  }
  throw err;
}

// --- shared encode helpers --------------------------------------------------

/** Validate framing metadata common to both envelope kinds on encode. */
function validateFramingForEncode(
  runId: string,
  caseId: string,
  codecVersion: string,
  messageLimitBytes: number,
): void {
  if (runId.length === 0 || caseId.length === 0 || codecVersion.length === 0) {
    throw new CodecEncodeError("runId/caseId/codecVersion must be non-empty");
  }
  if (
    !Number.isInteger(messageLimitBytes) ||
    messageLimitBytes <= 0 ||
    messageLimitBytes > MAX_PAYLOAD_BYTES
  ) {
    throw new CodecEncodeError(
      `messageLimitBytes must be a positive integer <= ${MAX_PAYLOAD_BYTES}`,
    );
  }
}

/** Assemble a JSON object from pre-sorted `[key, encodedValue]` pairs. */
function objectText(pairs: readonly (readonly [string, string])[]): string {
  return `{${pairs.map(([k, v]) => `${jsonString(k)}:${v}`).join(",")}}`;
}

/** Encode a JSON string leaf deterministically. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}
