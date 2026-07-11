/**
 * Slug validation.
 *
 * A problem slug is both a stable identifier and a single path segment under
 * `problems/<slug>/`, so it must be filesystem-safe and unambiguous. Slugs are
 * lowercase kebab-case: ASCII letters and digits grouped by single hyphens, with
 * no leading, trailing, or doubled hyphen. This rejects path separators,
 * whitespace, dots, and uppercase — anything that could escape the problem root
 * or collide across case-insensitive filesystems.
 *
 * This module is pure: it validates text and imports nothing.
 */

/** Maximum accepted slug length in characters. */
export const MAX_SLUG_LENGTH = 64;

/** Lowercase kebab-case: one or more hyphen-separated alphanumeric groups. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Report whether `value` is a well-formed slug.
 *
 * @param value - The candidate slug text.
 * @returns `true` iff `value` is non-empty, within {@link MAX_SLUG_LENGTH}, and
 *   matches the lowercase kebab-case shape.
 */
export function isValidSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(value)
  );
}

/**
 * Assert that `value` is a well-formed slug, returning it unchanged.
 *
 * @param value - The candidate slug text.
 * @returns The validated slug.
 * @throws {RangeError} If `value` is not a valid slug. Higher layers translate
 *   this into a {@link ProblemConfigError} where a configuration exit code is
 *   required; keeping the primitive check dependency-free lets it be reused by
 *   the `init` command's slug argument too.
 */
export function assertValidSlug(value: string): string {
  if (!isValidSlug(value)) {
    throw new RangeError(
      `invalid slug ${JSON.stringify(value)}: expected lowercase kebab-case ` +
        `(a-z, 0-9, single hyphens), 1-${MAX_SLUG_LENGTH} characters`,
    );
  }
  return value;
}
