/**
 * Bounded rendering of canonical values for mismatch diagnostics.
 *
 * A {@link ComparisonMismatch} carries human-oriented `expected`/`actual`
 * renderings. They must be bounded (a huge value must not produce an unbounded
 * message) and are never re-parsed as data. We reuse the codec's canonical
 * serializer so the rendering is deterministic and matches the wire form a
 * reader would see.
 *
 * This module lives in the judging layer and imports only its sibling codec
 * encoder plus the value model — no adapter, CLI, or Node module.
 */

import type { CanonicalValue } from "../value/model.js";
import { canonicalStringOf } from "../codec/encode.js";

/** Default maximum length of a rendered value before truncation. */
export const DEFAULT_RENDER_LIMIT = 120;

/**
 * Truncate `text` to at most `max` characters, appending an ellipsis marker
 * when content was dropped. `max` is treated as at least 1.
 *
 * @param text - The text to bound.
 * @param max - The maximum length of the returned string's content window.
 * @returns `text` unchanged, or a truncated prefix followed by `"…"`.
 */
export function truncate(text: string, max: number): string {
  const limit = Math.max(1, max);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Render a canonical value to bounded, deterministic diagnostic text.
 *
 * @param value - The value to render.
 * @param max - Maximum content length (defaults to {@link DEFAULT_RENDER_LIMIT}).
 * @returns The canonical JSON text of `value`, truncated to `max` characters.
 */
export function renderValue(
  value: CanonicalValue,
  max: number = DEFAULT_RENDER_LIMIT,
): string {
  return truncate(canonicalStringOf(value), max);
}
