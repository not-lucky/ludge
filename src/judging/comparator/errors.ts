/**
 * Comparator error types.
 *
 * The comparator throws only for a policy it cannot honor — an unrecognized or
 * unsupported-major {@link ComparisonPolicy} version. This is a configuration
 * error, not input variation, so (unlike a decode failure, which is reported as
 * a `DecodeResult`) it surfaces as a thrown error at the dispatch seam.
 *
 * The shape mirrors the codec error classes in `../codec/errors.ts`.
 */

/**
 * Thrown when a {@link ComparisonPolicy} names a version this build cannot
 * apply: either the version text is unrecognized, or its major version is not
 * supported. Supported minors of a supported major never raise this.
 */
export class UnsupportedComparisonPolicyError extends Error {
  public constructor(
    /** The offending policy version text. */
    public readonly version: string,
  ) {
    super(`unsupported comparison policy version: ${version}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}
