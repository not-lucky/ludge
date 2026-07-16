/**
 * Public surface of the `tagged-jsonl-v1` codec.
 *
 * This barrel re-exports the codec factory and version helpers, the JSON Lines
 * envelope API, the codec limits, and the codec error types. Internal helpers
 * (the strict JSON parser, UTF-8 primitives, leaf grammars, and the raw
 * encode/decode traversal) are deliberately not re-exported: callers depend on
 * the {@link Codec} port surface, not on the codec's internals.
 */

// Codec factory and version support.
export {
  CODEC_VERSION,
  SUPPORTED_CODEC_MAJOR,
  createTaggedJsonlV1Codec,
  isSupportedCodecVersion,
  parseCodecVersion,
} from "./tagged-jsonl-v1.js";
export type { CodecVersion, VersionedCodec } from "./tagged-jsonl-v1.js";

// Envelope framing.
export {
  PROTOCOL_VERSION,
  decodeRequestLine,
  decodeResponseLine,
  encodeRequestLine,
  encodeResponseLine,
} from "./envelope.js";
export type {
  EnvelopeDecodeResult,
  EnvelopeError,
  ExpectedResponse,
  RequestEnvelope,
  ResponseEnvelope,
} from "./envelope.js";

// Limits.
export { MAX_DEPTH, MAX_NODES, MAX_PAYLOAD_BYTES } from "./limits.js";

// Error types.
export { CanonicalValidationError, CodecEncodeError } from "./errors.js";
