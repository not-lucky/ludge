"""Leaf-grammar validators, base64url, and canonical float formatting.

This module is the Python mirror of ``src/judging/codec/leaf-grammar.ts`` and
``src/judging/codec/limits.ts``. It is the single source of truth in the harness
for the scalar ("leaf") grammars that make the ``tagged-jsonl-v1`` wire form
canonical: canonical floats, non-normalized decimal literals, canonical integer
strings, unpadded URL-safe base64, lowercase UUIDs, ISO dates/times without
embedded offsets, offset-minute ranges, and conservative relative paths.

Every validator is pure and total. The base64url helpers are deterministic, with
decoding reporting failure via ``None`` rather than exceptions. Keeping these
rules byte-identical to the TypeScript codec is what makes cross-language
byte-equality judging sound.
"""

from __future__ import annotations

import base64
import binascii
import re

# --- codec limits (mirror of limits.ts) -------------------------------------

#: Maximum nesting depth of a canonical value (inclusive).
MAX_DEPTH = 256

#: Maximum number of value nodes in a single canonical value.
MAX_NODES = 1_000_000

#: Maximum size, in bytes, of an encoded canonical payload (16 MiB).
MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

#: Edge of the IEEE-754 exact-integer range (``2**53 - 1``). Integers whose
#: magnitude is within this bound are emitted as bare JSON numbers; larger ones
#: travel as decimal strings so no precision is lost.
MAX_SAFE_INT = 9_007_199_254_740_991


class LimitExceededError(Exception):
    """Raised when a codec traversal exceeds a configured limit."""

    def __init__(self, limit: str, message: str) -> None:
        super().__init__(message)
        self.limit = limit


class Budget:
    """A mutable depth/node accountant for a single encode or decode traversal.

    A fresh :class:`Budget` is created per call. :meth:`enter` is called when
    descending into a container and :meth:`leave` when ascending; :meth:`count_node`
    tallies every value node. Both raise :class:`LimitExceededError` the instant a
    bound is crossed, mirroring ``limits.ts``.
    """

    __slots__ = ("_depth", "_nodes", "_max_depth", "_max_nodes")

    def __init__(self, max_depth: int = MAX_DEPTH, max_nodes: int = MAX_NODES) -> None:
        self._depth = 0
        self._nodes = 0
        self._max_depth = max_depth
        self._max_nodes = max_nodes

    def count_node(self) -> None:
        """Tally one value node, raising if the node budget is exhausted."""
        self._nodes += 1
        if self._nodes > self._max_nodes:
            raise LimitExceededError(
                "nodes", f"node count exceeds limit of {self._max_nodes}"
            )

    def enter(self) -> None:
        """Descend one level, raising if the depth budget is exceeded."""
        self._depth += 1
        if self._depth > self._max_depth:
            raise LimitExceededError(
                "depth", f"nesting depth exceeds limit of {self._max_depth}"
            )

    def leave(self) -> None:
        """Ascend one level."""
        self._depth -= 1


# --- float grammar ----------------------------------------------------------

_CANONICAL_FLOAT_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?(e[+-][1-9][0-9]*)?$")


def is_canonical_float(value: str, negative_zero: bool) -> bool:
    """Whether ``value`` is a canonical finite float under ``negative_zero``.

    Mirror of ``isCanonicalFloat``: rejects leading zeros, trailing fraction
    zeros, unsigned/zero exponents, and the literal ``-0``; a zero magnitude
    must be exactly ``"0"``; and when ``negative_zero`` is set the text must be
    exactly ``"0"`` (the sign is carried by the flag, never the text).
    """
    match = _CANONICAL_FLOAT_RE.match(value)
    if match is None:
        return False
    integer_part = match.group(1)
    fraction = match.group(2)
    if integer_part == "0" and fraction is None:
        if value != "0":
            return False
    if negative_zero and value != "0":
        return False
    return True


_ECMA_INT_EXPONENT_LIMIT = 21


def _ecma_number_text(digits: str, k: int, n: int) -> str:
    """Format significant ``digits`` per the ECMAScript ``Number::toString`` rules.

    ``digits`` are the shortest-round-trip significant digits (no leading or
    trailing zeros), ``k = len(digits)``, and ``n`` is the position of the
    decimal point measured from the start of ``digits`` (value = digits x
    10**(n-k)). This reproduces the exact plain/exponential thresholds JavaScript
    uses, so a float computed in Python serializes to the same text a JS-authored
    canonical float would.
    """
    if k <= n <= _ECMA_INT_EXPONENT_LIMIT:
        return digits + "0" * (n - k)
    if 0 < n <= _ECMA_INT_EXPONENT_LIMIT:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    exponent = n - 1
    exp_sign = "+" if exponent >= 0 else "-"
    exp_str = str(abs(exponent))
    if k == 1:
        return digits + "e" + exp_sign + exp_str
    return digits[0] + "." + digits[1:] + "e" + exp_sign + exp_str


def canonical_float_text(x: float) -> str:
    """Render a finite Python ``float`` as canonical float text.

    Uses Python's shortest-round-trip ``repr`` to recover the significant digits,
    then reformats them with the ECMAScript number-to-string algorithm so the
    output matches the canonical ``float`` grammar and, for the common cases, the
    byte-exact text a TypeScript-authored value would carry. ``-0.0`` and ``0.0``
    both render as ``"0"`` (sign is carried separately by ``negativeZero``).

    :raises ValueError: If ``x`` is NaN or infinite.
    """
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("non-finite float is not representable")
    if x == 0.0:
        return "0"
    negative = x < 0.0
    text = repr(abs(x))
    if "e" in text or "E" in text:
        mantissa, _, exponent = text.lower().partition("e")
        exp_val = int(exponent)
    else:
        mantissa = text
        exp_val = 0
    if "." in mantissa:
        int_part, frac_part = mantissa.split(".")
    else:
        int_part, frac_part = mantissa, ""
    all_digits = int_part + frac_part
    point_exp = exp_val - len(frac_part)
    all_digits = all_digits.lstrip("0")
    stripped = all_digits.rstrip("0")
    if stripped == "":
        return "0"
    point_exp += len(all_digits) - len(stripped)
    digits = stripped
    k = len(digits)
    n = point_exp + k
    rendered = _ecma_number_text(digits, k, n)
    return ("-" + rendered) if negative else rendered


# --- decimal / integer grammars ---------------------------------------------

_DECIMAL_RE = re.compile(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$")
_DIGIT_RE = re.compile(r"[0-9]")
_CANONICAL_INT_RE = re.compile(r"^-?(0|[1-9][0-9]*)$")


def is_valid_decimal_literal(value: str) -> bool:
    """Whether ``value`` is a finite, non-normalized decimal literal.

    Mirror of ``isValidDecimalLiteral``: trailing zeros and either-case exponents
    are permitted; ``Inf``/``Infinity``/``NaN``/``sNaN`` and the empty string are
    rejected because they never match the grammar.
    """
    if _DECIMAL_RE.match(value) is None:
        return False
    return _DIGIT_RE.search(value) is not None


def is_canonical_int_string(value: str) -> bool:
    """Whether ``value`` is a canonical decimal integer string.

    Mirror of ``isCanonicalIntString``: matches ``-?(0|[1-9][0-9]*)`` and is not
    the literal ``-0``.
    """
    return _CANONICAL_INT_RE.match(value) is not None and value != "-0"


# --- base64url ---------------------------------------------------------------

_BASE64URL_ALPHABET = re.compile(r"^[A-Za-z0-9_-]*$")


def encode_base64url(data: bytes) -> str:
    """Encode bytes to unpadded, URL-safe base64 (``base64url``).

    Mirror of ``encodeBase64Url``: RFC 4648 URL-safe alphabet with no ``=``
    padding.
    """
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def decode_base64url(value: str) -> bytes | None:
    """Decode an unpadded, URL-safe base64 string, or return ``None``.

    Mirror of ``decodeBase64Url``: rejects any non-alphabet character (including
    ``=`` padding), an impossible ``length % 4 == 1``, and any non-canonical
    encoding whose unused trailing bits are non-zero. Canonicality is enforced by
    re-encoding and comparing to the input. The empty string decodes to empty
    bytes.
    """
    if len(value) % 4 == 1:
        return None
    if _BASE64URL_ALPHABET.match(value) is None:
        return None
    padding = "=" * ((-len(value)) % 4)
    try:
        raw = base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        return None
    if encode_base64url(raw) != value:
        return None
    return raw


# --- uuid / temporal / offset grammars --------------------------------------

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_TIME_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$")


def is_valid_uuid(value: str) -> bool:
    """Whether ``value`` is a lowercase canonical UUID (uppercase is not canonical)."""
    return _UUID_RE.match(value) is not None


def _is_leap_year(year: int) -> bool:
    """Whether ``year`` is a Gregorian leap year."""
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def is_valid_date(value: str) -> bool:
    """Whether ``value`` is a real calendar date ``YYYY-MM-DD`` (with leap rules)."""
    match = _DATE_RE.match(value)
    if match is None:
        return False
    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    if month < 1 or month > 12:
        return False
    month_lengths = [
        31,
        29 if _is_leap_year(year) else 28,
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
    ]
    return 1 <= day <= month_lengths[month - 1]


def is_valid_time_of_day(value: str) -> bool:
    """Whether ``value`` is ``HH:MM:SS`` with an optional 1-6 digit fraction.

    No timezone or offset text is permitted; the offset is carried separately.
    """
    match = _TIME_RE.match(value)
    if match is None:
        return False
    hour = int(match.group(1))
    minute = int(match.group(2))
    second = int(match.group(3))
    return hour <= 23 and minute <= 59 and second <= 59


def is_valid_datetime_text(value: str) -> bool:
    """Whether ``value`` is ``<date>T<timeOfDay>`` with no offset text."""
    separator_index = value.find("T")
    if separator_index < 0:
        return False
    date_part = value[:separator_index]
    time_part = value[separator_index + 1 :]
    return is_valid_date(date_part) and is_valid_time_of_day(time_part)


def is_valid_offset_minutes(n: int) -> bool:
    """Whether ``n`` is an integer offset in ``-1439..1439``."""
    return isinstance(n, int) and -1439 <= n <= 1439


# --- relative path grammar ---------------------------------------------------

_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")


def is_canonical_relative_path(value: str, flavor: str) -> bool:
    """Whether ``value`` is a canonical, normalized relative path.

    Mirror of ``isCanonicalRelativePath``: rejects the empty string, the wrong
    separator for the flavor, any absolute form (leading separator, UNC prefix,
    or Windows drive designator), and any empty/``.``/``..`` segment.
    """
    if value == "":
        return False
    separator = "/" if flavor == "posix" else "\\"
    if flavor == "windows":
        if "/" in value:
            return False
        if value.startswith("\\"):
            return False
        if _WINDOWS_DRIVE_RE.match(value) is not None:
            return False
    else:
        if value.startswith("/"):
            return False
    for segment in value.split(separator):
        if segment in ("", ".", ".."):
            return False
    return True
