/**
 * Codec error types.
 *
 * The codec distinguishes two failure surfaces. Encoding an invalid in-memory
 * value is a programming error and throws {@link CodecEncodeError}. Decoding
 * malformed or non-canonical bytes is expected input variation, so the value
 * builder throws {@link CanonicalValidationError} which the codec catches and
 * converts into a `DecodeResult` failure (the public `decode` never throws).
 *
 * Both carry an optional canonical `path` (e.g. `"$.items[3].value"`) for
 * human-oriented diagnostics; the text is bounded and never re-parsed as data.
 */

/**
 * Thrown by the encoder when a {@link CanonicalValue} cannot be encoded: a
 * non-finite or non-canonical leaf, a reference cycle, duplicate set/dict
 * members, or an exceeded limit surfaced during encoding.
 */
export class CodecEncodeError extends Error {
  public constructor(
    message: string,
    /** Canonical path to the offending location, when known. */
    public readonly path?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Thrown by the value builder when decoded JSON violates the normative value
 * model: an unknown tag, a forbidden/missing field, a bad leaf grammar,
 * non-canonical ordering, or a structural adapter-shape violation. It is caught
 * by the codec and reported as a decode failure.
 */
export class CanonicalValidationError extends Error {
  public constructor(
    message: string,
    /** Canonical path to the offending location, when known. */
    public readonly path?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}
