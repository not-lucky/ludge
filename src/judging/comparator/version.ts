/**
 * Comparison-policy version parsing and support checks.
 *
 * A {@link ComparisonPolicy}'s `version` selects a concrete comparator. Versions
 * are named `<family>-v<major>[.<minor>]` (for example `exact-v1` or
 * `exact-v1.3`). Following the value-model protocol, a reader accepts any minor
 * of a supported major and rejects every other (or unrecognized) version.
 *
 * This mirrors the codec's version helpers in
 * `../codec/tagged-jsonl-v1.ts` so both seams evolve the same way: majors are
 * breaking, minors are backward-compatible migrations.
 *
 * This module is pure: it parses text and imports nothing.
 */

/** The version identifier of the default `exact-v1` comparison policy. */
export const EXACT_V1_VERSION = "exact-v1";

/** The `exact` policy family name (the only family this build implements). */
export const EXACT_FAMILY = "exact";

/** The only comparison-policy major version this build supports. */
export const SUPPORTED_POLICY_MAJOR = 1;

/** A parsed comparison-policy version: `<family>-v<major>[.<minor>]`. */
export interface PolicyVersion {
  /** The policy family, e.g. `"exact"`. */
  readonly family: string;
  /** The major version; a breaking change increments it. */
  readonly major: number;
  /** The minor version; `0` when omitted. A minor bump is compatible. */
  readonly minor: number;
}

/**
 * Parse a comparison-policy version of the form `<family>-v<major>[.<minor>]`.
 *
 * The family is a lowercase identifier, `major`/`minor` are non-negative
 * integers, and `minor` defaults to `0` when absent.
 *
 * @param version - The version text.
 * @returns The parsed family/major/minor, or `null` if the text is unrecognized.
 */
export function parsePolicyVersion(version: string): PolicyVersion | null {
  const match = /^([a-z][a-z0-9]*)-v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) {
    return null;
  }
  const family = match[1];
  const majorText = match[2];
  if (family === undefined || majorText === undefined) {
    return null;
  }
  const major = Number(majorText);
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  return { family, major, minor };
}

/**
 * Whether a comparison-policy version is supported by this build.
 *
 * A version is supported iff it names the {@link EXACT_FAMILY} family at the
 * {@link SUPPORTED_POLICY_MAJOR} major version; any minor of that major is
 * accepted (supported-minor migration).
 *
 * @param version - The version text to test.
 * @returns `true` iff a comparator exists for `version`.
 */
export function isSupportedPolicyVersion(version: string): boolean {
  const parsed = parsePolicyVersion(version);
  return (
    parsed !== null &&
    parsed.family === EXACT_FAMILY &&
    parsed.major === SUPPORTED_POLICY_MAJOR
  );
}
