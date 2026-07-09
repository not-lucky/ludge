/**
 * UTF-8 encoding/decoding and byte-order helpers for the codec layer.
 *
 * The `tagged-jsonl-v1` codec must reason about the *byte* representation of
 * text, not JavaScript's native UTF-16 view. This module provides the narrow
 * set of primitives that need Node's `TextEncoder`/`TextDecoder`: strict
 * (fatal) decoding, a shared encoder, UTF-8 byte-order comparison, and lone
 * surrogate detection. Keeping these here isolates the codec's runtime
 * dependency on the encoding built-ins away from the pure domain layer.
 */

/**
 * A single shared encoder.
 *
 * `TextEncoder` is stateless for `encode` and always emits UTF-8, so one
 * instance can be reused across every call without allocation churn.
 */
const sharedEncoder = new TextEncoder();

/**
 * A single shared strict decoder.
 *
 * `fatal: true` makes malformed byte sequences throw rather than silently
 * substituting U+FFFD, which is what {@link decodeUtf8Fatal} relies on.
 * `ignoreBOM: true` preserves a leading BOM as U+FEFF instead of stripping it,
 * because silent BOM removal would corrupt payloads that legitimately begin
 * with that code point.
 */
const sharedFatalDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/**
 * Encode a string as UTF-8 bytes using the shared module-level encoder.
 *
 * @param text - The string to encode.
 * @returns The UTF-8 byte sequence.
 */
export function encodeUtf8(text: string): Uint8Array {
  return sharedEncoder.encode(text);
}

/**
 * Raised by {@link decodeUtf8Fatal} when the input is not valid UTF-8.
 *
 * The prototype chain is restored via `Object.setPrototypeOf` so that
 * `instanceof` works even when the class is down-compiled to a target that
 * breaks native `Error` subclassing.
 */
export class Utf8DecodeError extends Error {
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Strictly decode UTF-8 bytes to a string.
 *
 * Uses a fatal decoder, so any invalid or truncated multibyte sequence causes
 * a throw. That throw is caught and re-thrown as a {@link Utf8DecodeError} with
 * a bounded (non-input-echoing) message, so error text never leaks payload
 * bytes. A leading BOM is preserved as U+FEFF rather than stripped.
 *
 * @param bytes - The UTF-8 byte sequence to decode.
 * @returns The decoded string.
 * @throws {Utf8DecodeError} If `bytes` is not valid UTF-8.
 */
export function decodeUtf8Fatal(bytes: Uint8Array): string {
  try {
    return sharedFatalDecoder.decode(bytes);
  } catch {
    throw new Utf8DecodeError("invalid UTF-8 in input bytes");
  }
}

/**
 * Compare two strings by their UTF-8 byte sequences.
 *
 * JavaScript's native `<`/`>` on strings compares UTF-16 code units, which
 * diverges from UTF-8 byte order for characters outside the BMP (surrogate
 * code units 0xD800..0xDFFF sort before code points that encode to lower
 * UTF-8 bytes). Canonical ordering in the codec is defined over UTF-8 bytes,
 * so we encode both operands and compare byte-by-byte, breaking ties by the
 * shorter length. This yields a correct total order over UTF-8 byte sequences.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns Negative if `a` sorts before `b`, `0` if equal, positive otherwise.
 */
export function compareUtf8(a: string, b: string): number {
  const bytesA = encodeUtf8(a);
  const bytesB = encodeUtf8(b);
  const shared = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < shared; i += 1) {
    // Safe: `i < shared <= length`, so both indexes are in bounds.
    const byteA = bytesA[i] as number;
    const byteB = bytesB[i] as number;
    if (byteA !== byteB) {
      return byteA - byteB;
    }
  }
  return bytesA.length - bytesB.length;
}

/**
 * Report whether a string contains any unpaired UTF-16 surrogate.
 *
 * A well-formed astral code point is stored as a high surrogate
 * (`\uD800..\uDBFF`) immediately followed by a low surrogate
 * (`\uDC00..\uDFFF`). A high surrogate not followed by a low one, or a low
 * surrogate not preceded by a high one, is "lone" and cannot be encoded as
 * valid UTF-8. Detecting this lets the codec reject such strings before an
 * encode attempt produces replacement characters.
 *
 * @param text - The string to inspect.
 * @returns `true` if any lone surrogate is present.
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be immediately followed by a low surrogate.
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // Consume the valid pair.
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate reached without a preceding high surrogate is lone; a
      // valid pair would have been consumed above.
      return true;
    }
  }
  return false;
}
