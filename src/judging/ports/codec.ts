/**
 * Value codec port.
 *
 * A {@link Codec} frames a canonical value into transport bytes and parses
 * bytes back into a canonical value, validating limits and canonical form
 * before any application code sees the value. It is the Bridge between judging
 * policy (which reasons about decoded values) and the wire mechanics of a
 * particular runtime backend.
 *
 * This module is pure: it declares contracts only and imports no runtime,
 * adapter, or Node module.
 */

/**
 * A bounded, non-executable diagnostic describing why a decode failed.
 *
 * A codec failure is surfaced by the application layer as `protocol_error`; the
 * fields here are for human-oriented reporting only and are never re-parsed as
 * canonical data.
 */
export interface DecodeError {
  /** Short, bounded explanation of the failure. */
  readonly message: string;
  /** Optional canonical path to the offending location (e.g. `"$.items[3]"`). */
  readonly path?: string;
}

/**
 * The result of decoding transport bytes.
 *
 * A discriminated union so callers must narrow on `ok` before touching either
 * the decoded `value` or the `error`; a codec never throws for malformed input,
 * it reports a failure the caller classifies.
 *
 * @typeParam TValue - The canonical value model produced on success (task 04).
 */
export type DecodeResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: DecodeError };

/**
 * Encodes and decodes canonical values for one runtime backend.
 *
 * `TValue` is the canonical value model defined in task 04; task 03 fixes only
 * the contract so judging policy depends on the port, not a concrete codec. The
 * `Tag` brand keeps a codec bound to the {@link RuntimeBundle} that produced it:
 * because `backendId` is a used member, a `Codec<TValue, "a">` is not assignable
 * where a `Codec<TValue, "b">` is expected, so an incompatible codec cannot be
 * paired with a foreign launcher at the type level.
 *
 * @typeParam TValue - The canonical value model this codec frames.
 * @typeParam Tag - The owning backend's coherence tag.
 */
export interface Codec<TValue, Tag extends string = string> {
  /** The backend this codec belongs to; enforces bundle coherence. */
  readonly backendId: Tag;
  /**
   * Frame a canonical value into transport bytes.
   *
   * @param value - The canonical value to encode.
   * @returns The encoded bytes.
   */
  encode(value: TValue): Uint8Array;
  /**
   * Parse transport bytes, validating limits and canonical form.
   *
   * @param bytes - The bytes to decode.
   * @returns A success carrying the decoded value, or a failure diagnostic.
   */
  decode(bytes: Uint8Array): DecodeResult<TValue>;
}
