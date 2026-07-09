/**
 * Normative leaf-grammar validators for the Palestra Judge canonical value
 * codec.
 *
 * The tagged value model stores scalar payloads ("leaves") as text or bytes
 * that must obey precise, canonical grammars so that equal values always have
 * one and only one serialized form. This module is the single source of truth
 * for those grammars: canonical floats, non-normalized decimal literals,
 * canonical integer strings, unpadded URL-safe base64, lowercase UUIDs, ISO
 * dates/times without embedded offsets, offset-minute ranges, and conservative
 * relative paths.
 *
 * Every validator is pure and total: it inspects only its arguments, holds no
 * mutable state, and never throws. Codec helpers ({@link encodeBase64Url},
 * {@link decodeBase64Url}) are likewise deterministic, with decoding reporting
 * failure via `null` rather than exceptions.
 */

/**
 * The URL-safe base64 alphabet in index order.
 *
 * Indices 0..25 map to `A-Z`, 26..51 to `a-z`, 52..61 to `0-9`, 62 to `-`, and
 * 63 to `_`. This is the RFC 4648 "base64url" alphabet with no padding.
 */
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Reverse lookup from a base64url character to its 6-bit value.
 *
 * Built once from {@link BASE64URL_ALPHABET}. A missing key yields `undefined`,
 * which {@link decodeBase64Url} treats as an invalid character (this also
 * rejects `=` padding, since padding is not part of the alphabet).
 */
const BASE64URL_DECODE: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE64URL_ALPHABET.length; i += 1) {
    map[BASE64URL_ALPHABET.charAt(i)] = i;
  }
  return map;
})();

/**
 * Canonical finite-float text grammar.
 *
 * A value is canonical iff every rule below holds:
 *
 * 1. It matches `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?(e[+-][1-9][0-9]*)?$`:
 *    - an optional leading `-`;
 *    - an integer part that is either `0` or a nonzero-leading digit run (no
 *      leading zeros);
 *    - an optional fraction: a dot followed by zero-or-more digits that END in
 *      a nonzero digit, so there are never trailing zeros and there is always
 *      at least one digit after the dot;
 *    - an optional exponent: lowercase `e`, an explicit `+` or `-` sign, then a
 *      nonzero-leading digit run (so no exponent of zero and no leading zeros).
 * 2. The literal `-0` is rejected: signed zero is carried by the
 *    `negativeZero` flag, never by the text.
 * 3. A zero magnitude must be written exactly as `"0"`. Concretely, if the
 *    integer part is `"0"` and there is no fraction, the whole value must equal
 *    `"0"` (no sign, no exponent). This rejects `"-0"`, `"0e+1"`, `"-0e+5"`
 *    while still accepting genuinely nonzero values like `"0.25"`.
 * 4. When `negativeZero` is `true`, the value MUST be exactly `"0"` (the text
 *    of negative zero is the canonical zero, distinguished only by the flag).
 *    When `negativeZero` is `false`, no additional constraint applies.
 *
 * @param value - The candidate float text.
 * @param negativeZero - Whether this float represents negative zero.
 * @returns `true` iff `value` is a canonical finite float under the flag.
 */
export function isCanonicalFloat(value: string, negativeZero: boolean): boolean {
  const match = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?(e[+-][1-9][0-9]*)?$/.exec(
    value,
  );
  if (match === null) {
    return false;
  }
  const integerPart = match[1];
  const fraction = match[2];
  if (integerPart === "0" && fraction === undefined) {
    if (value !== "0") {
      return false;
    }
  }
  if (negativeZero && value !== "0") {
    return false;
  }
  return true;
}

/**
 * Non-normalized finite Python-`Decimal`-style literal grammar.
 *
 * Accepts the textual forms `Decimal(...)` round-trips without normalization:
 * trailing zeros and either-case exponents are permitted. A value is valid iff
 * it matches `^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$` and contains
 * at least one digit. The digit requirement is implied by the regex but is
 * asserted explicitly for clarity and robustness.
 *
 * The special tokens `Inf`, `Infinity`, `NaN`, `sNaN`, and the empty string are
 * rejected because they never match the grammar.
 *
 * @param value - The candidate decimal literal.
 * @returns `true` iff `value` is a finite, non-normalized decimal literal.
 */
export function isValidDecimalLiteral(value: string): boolean {
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(value)) {
    return false;
  }
  return /[0-9]/.test(value);
}

/**
 * Canonical decimal integer string grammar.
 *
 * Used when an integer is transmitted as text. A value is canonical iff it
 * matches `^-?(0|[1-9][0-9]*)$` and is not the literal `"-0"`. The explicit
 * `"-0"` exclusion is required because the regex alone would accept it.
 *
 * @param value - The candidate integer text.
 * @returns `true` iff `value` is a canonical decimal integer string.
 */
export function isCanonicalIntString(value: string): boolean {
  return /^-?(0|[1-9][0-9]*)$/.test(value) && value !== "-0";
}

/**
 * Encode bytes to unpadded, URL-safe base64 ("base64url").
 *
 * Uses a pure-JS routine over {@link BASE64URL_ALPHABET} rather than `btoa`, so
 * the exact output is fully controlled. Every group of three input bytes maps
 * to four output characters; a trailing group of one or two bytes emits two or
 * three characters respectively, with NO `=` padding.
 *
 * @param bytes - The bytes to encode.
 * @returns The canonical unpadded base64url string (empty for empty input).
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < len ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < len ? (bytes[i + 2] ?? 0) : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64URL_ALPHABET.charAt((triple >> 18) & 0x3f);
    out += BASE64URL_ALPHABET.charAt((triple >> 12) & 0x3f);
    if (i + 1 < len) {
      out += BASE64URL_ALPHABET.charAt((triple >> 6) & 0x3f);
    }
    if (i + 2 < len) {
      out += BASE64URL_ALPHABET.charAt(triple & 0x3f);
    }
  }
  return out;
}

/**
 * Decode an unpadded, URL-safe base64 string, or report failure.
 *
 * Returns `null` (never throws) when the input is not exactly what
 * {@link encodeBase64Url} would produce for some byte sequence:
 *
 * - any character outside {@link BASE64URL_ALPHABET} (this includes `=`
 *   padding);
 * - a length congruent to 1 modulo 4, which is an impossible base64 length;
 * - a final quantum whose unused low-order bits are non-zero, i.e. a
 *   non-canonical encoding.
 *
 * The canonicality guarantee is enforced by decoding leniently and then
 * checking that re-encoding reproduces the input exactly. The empty string
 * decodes to a zero-length array.
 *
 * @param value - The candidate base64url string.
 * @returns The decoded bytes, or `null` if `value` is not canonical base64url.
 */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length % 4 === 1) {
    return null;
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < value.length; i += 1) {
    const sextet = BASE64URL_DECODE[value.charAt(i)];
    if (sextet === undefined) {
      return null;
    }
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  const result = new Uint8Array(bytes);
  if (encodeBase64Url(result) !== value) {
    return null;
  }
  return result;
}

/**
 * Lowercase canonical UUID grammar.
 *
 * A value is canonical iff it matches
 * `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Uppercase
 * hex digits are deliberately NOT canonical, so `"A"`-style UUIDs return
 * `false`.
 *
 * @param value - The candidate UUID text.
 * @returns `true` iff `value` is a lowercase canonical UUID.
 */
export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
}

/**
 * Whether a year is a Gregorian leap year.
 *
 * A year is a leap year iff it is divisible by 4 and either not divisible by
 * 100 or divisible by 400.
 *
 * @param year - The (already validated) 4-digit year.
 * @returns `true` iff `year` is a leap year.
 */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Calendar-date grammar: `YYYY-MM-DD`.
 *
 * A value is valid iff it has a 4-digit year (`0000`-`9999`), a month `01`-`12`,
 * and a day that is valid for that month, including leap-year rules for
 * February (see {@link isLeapYear}). No time or offset text is permitted.
 *
 * @param value - The candidate date text.
 * @returns `true` iff `value` is a real calendar date in `YYYY-MM-DD` form.
 */
export function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const yearStr = match[1];
  const monthStr = match[2];
  const dayStr = match[3];
  if (yearStr === undefined || monthStr === undefined || dayStr === undefined) {
    return false;
  }
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12) {
    return false;
  }
  const monthLengths = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maxDay = monthLengths[month - 1];
  if (maxDay === undefined) {
    return false;
  }
  return day >= 1 && day <= maxDay;
}

/**
 * Wall-clock time-of-day grammar: `HH:MM:SS` with optional fraction.
 *
 * A value is valid iff it matches `HH:MM:SS` optionally followed by a `.` and 1
 * to 6 fractional-second digits, with `HH` in `00`-`23`, `MM` in `00`-`59`, and
 * `SS` in `00`-`59`. No timezone or offset text is permitted; the offset is
 * carried separately by the value model.
 *
 * @param value - The candidate time text.
 * @returns `true` iff `value` is a valid time of day.
 */
export function isValidTimeOfDay(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/.exec(value);
  if (match === null) {
    return false;
  }
  const hourStr = match[1];
  const minuteStr = match[2];
  const secondStr = match[3];
  if (hourStr === undefined || minuteStr === undefined || secondStr === undefined) {
    return false;
  }
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * Combined date-time grammar: `<date>T<timeOfDay>`.
 *
 * A value is valid iff it consists of a date satisfying {@link isValidDate} and
 * a time satisfying {@link isValidTimeOfDay}, joined by a single literal
 * uppercase `T`. No timezone or offset text is permitted. The date part never
 * contains a `T`, so the first `T` is unambiguously the separator; any stray
 * `T` in the time part will fail {@link isValidTimeOfDay}.
 *
 * @param value - The candidate date-time text.
 * @returns `true` iff `value` is a valid `<date>T<timeOfDay>`.
 */
export function isValidDatetimeText(value: string): boolean {
  const separatorIndex = value.indexOf("T");
  if (separatorIndex < 0) {
    return false;
  }
  const datePart = value.slice(0, separatorIndex);
  const timePart = value.slice(separatorIndex + 1);
  return isValidDate(datePart) && isValidTimeOfDay(timePart);
}

/**
 * Offset-minute range check.
 *
 * The value model carries timezone offsets as whole minutes east of UTC. A
 * value is valid iff it is an integer (per `Number.isInteger`) within the
 * inclusive range `-1439..1439` (one minute short of a full day in each
 * direction).
 *
 * @param n - The candidate offset in minutes.
 * @returns `true` iff `n` is an integer in `-1439..1439`.
 */
export function isValidOffsetMinutes(n: number): boolean {
  return Number.isInteger(n) && n >= -1439 && n <= 1439;
}

/**
 * Canonical relative-path grammar for POSIX or Windows flavors.
 *
 * These rules are deliberately conservative to avoid ever accepting a path that
 * could leak or resolve to a host-absolute location, and to reject any form
 * that a normalizer would have rewritten:
 *
 * - The empty string is rejected.
 * - The separator is `/` for `posix` and a single backslash `\` for `windows`.
 *   Using the wrong separator for the flavor is non-canonical; `windows`
 *   additionally rejects any forward slash `/`.
 * - Absolute paths are rejected: a leading `/` (posix); a leading backslash
 *   (windows), which also covers UNC `\\` prefixes; and a Windows drive
 *   designator, i.e. a leading letter immediately followed by `:` (`C:...`).
 * - The path is split on the flavor separator and each segment is checked:
 *   an EMPTY segment is rejected (this catches trailing separators and doubled
 *   separators); a `.` segment is rejected (redundant); and ANY `..` segment is
 *   rejected. A leading `..` would escape upward, and an interior `..` would
 *   have been collapsed by normalization, so for a normalized canonical path no
 *   `..` may appear at all.
 *
 * @param value - The candidate relative path.
 * @param flavor - Which separator/absolute conventions to apply.
 * @returns `true` iff `value` is a canonical, normalized relative path.
 */
export function isCanonicalRelativePath(
  value: string,
  flavor: "posix" | "windows",
): boolean {
  if (value === "") {
    return false;
  }
  const separator = flavor === "posix" ? "/" : "\\";
  if (flavor === "windows") {
    if (value.includes("/")) {
      return false;
    }
    if (value.startsWith("\\")) {
      return false;
    }
    if (/^[A-Za-z]:/.test(value)) {
      return false;
    }
  } else {
    if (value.startsWith("/")) {
      return false;
    }
  }
  const segments = value.split(separator);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}
