/**
 * The `tagged-jsonl-v1` codec.
 *
 * This module assembles the encoder ({@link encodeValue}) and the strict value
 * builder ({@link buildValue}) into a {@link Codec} that conforms to the judging
 * port. Encoding a value yields canonical UTF-8 bytes; decoding bytes validates
 * limits, framing, and canonical form before returning a value, and never
 * throws (malformed input becomes a {@link DecodeResult} failure).
 *
 * The codec is created through a factory that binds it to a backend coherence
 * tag, honoring the port's brand so an incompatible codec cannot be paired with
 * a foreign launcher at the type level.
 */

import type { Codec, DecodeResult } from "../ports/index.js";
import type { CanonicalValue } from "../value/model.js";
import { Budget, MAX_PAYLOAD_BYTES } from "./limits.js";
import { CanonicalValidationError } from "./errors.js";
import { encodeValue } from "./encode.js";
import { buildValue } from "./decode.js";
import { parseJson } from "./json.js";
import { decodeUtf8Fatal, encodeUtf8 } from "./utf8.js";

/** The wire/version identifier this codec produces and accepts. */
export const CODEC_VERSION = "tagged-jsonl-v1";

/** The only codec major version this build supports. */
export const SUPPORTED_CODEC_MAJOR = 1;

/**
 * A {@link Codec} that also advertises its version identifier.
 *
 * The version lets envelope readers reject unsupported major versions and
 * migrate supported minor ones (see {@link parseCodecVersion}).
 */
export interface VersionedCodec<TValue, Tag extends string = string>
  extends Codec<TValue, Tag> {
  /** The codec version identifier, e.g. `"tagged-jsonl-v1"`. */
  readonly version: string;
}

/** A parsed codec version: `tagged-jsonl-v<major>[.<minor>]`. */
export interface CodecVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * Parse a codec version string of the form `tagged-jsonl-v<major>[.<minor>]`.
 *
 * @param version - The version text.
 * @returns The parsed major/minor, or `null` if the text is not recognized.
 */
export function parseCodecVersion(version: string): CodecVersion | null {
  const match = /^tagged-jsonl-v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return { major, minor };
}

/**
 * Whether a codec version is supported by this build.
 *
 * A reader accepts any minor version of the supported major and rejects every
 * other (or unrecognized) version.
 *
 * @param version - The version text to test.
 * @returns `true` iff the major version matches {@link SUPPORTED_CODEC_MAJOR}.
 */
export function isSupportedCodecVersion(version: string): boolean {
  const parsed = parseCodecVersion(version);
  return parsed !== null && parsed.major === SUPPORTED_CODEC_MAJOR;
}

/**
 * Create a `tagged-jsonl-v1` codec bound to a backend coherence tag.
 *
 * @typeParam Tag - The owning backend's coherence tag.
 * @param backendId - The backend this codec belongs to.
 * @returns A versioned codec over {@link CanonicalValue}.
 */
export function createTaggedJsonlV1Codec<Tag extends string>(
  backendId: Tag,
): VersionedCodec<CanonicalValue, Tag> {
  return {
    backendId,
    version: CODEC_VERSION,

    encode(value: CanonicalValue): Uint8Array {
      // `encodeValue` throws CodecEncodeError on an invalid in-memory value.
      const bytes = encodeUtf8(encodeValue(value, new Budget()));
      if (bytes.length > MAX_PAYLOAD_BYTES) {
        throw new CanonicalValidationError(
          `encoded payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
        );
      }
      return bytes;
    },

    decode(bytes: Uint8Array): DecodeResult<CanonicalValue> {
      if (bytes.length > MAX_PAYLOAD_BYTES) {
        return fail(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      }
      let text: string;
      try {
        text = decodeUtf8Fatal(bytes);
      } catch (err) {
        return fail(messageOf(err));
      }
      const parsed = parseJson(text);
      if (!parsed.ok) {
        return fail(parsed.error.message);
      }
      try {
        return { ok: true, value: buildValue(parsed.node, new Budget()) };
      } catch (err) {
        if (err instanceof CanonicalValidationError) {
          return err.path === undefined
            ? fail(err.message)
            : { ok: false, error: { message: err.message, path: err.path } };
        }
        return fail(messageOf(err));
      }
    },
  };
}

/** Build a path-less decode failure result. */
function fail(message: string): DecodeResult<CanonicalValue> {
  return { ok: false, error: { message } };
}

/** Extract a bounded message from an unknown thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "decode failed";
}
