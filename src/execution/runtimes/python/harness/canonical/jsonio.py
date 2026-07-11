"""Strict JSON parsing and canonical JSON-string serialization.

Mirror of ``src/judging/codec/json.ts`` (parsing) and the ``jsonString`` helper
shared by ``encode.ts``/``envelope.ts`` (serialization).

The harness must not rely on a lax JSON reader. Like the TypeScript codec, this
parser rejects duplicate object keys, preserves number tokens as their exact raw
source text (never coercing to a float), and rejects the ``NaN``/``Infinity``
JSON5-isms. Serialization reproduces ``JSON.stringify`` string escaping exactly:
the short escapes ``\\b \\t \\n \\f \\r \\" \\\\``, ``\\uXXXX`` (lowercase) for
other C0 controls, and every other code point emitted raw so the UTF-8 bytes
match byte-for-byte.
"""

from __future__ import annotations

import json
from typing import Any

# A JSON tree is represented with native Python objects, matching the shapes the
# decoder expects:
#   * null    -> None
#   * bool    -> bool
#   * number  -> JsonNumber (raw source text preserved)
#   * string  -> str
#   * array   -> list
#   * object  -> dict (insertion-ordered; duplicate keys already rejected)


class JsonNumber:
    """A JSON number token carrying its exact raw source text.

    The raw text is preserved (never converted to ``float``) so the decoder can
    apply the canonical integer/offset grammars against the original digits,
    exactly as ``json.ts`` does with its ``raw`` field.
    """

    __slots__ = ("raw",)

    def __init__(self, raw: str) -> None:
        self.raw = raw

    def __repr__(self) -> str:  # pragma: no cover - debug aid only
        return f"JsonNumber({self.raw!r})"


class JsonParseError(Exception):
    """Raised when input is not valid JSON under the strict subset grammar."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """``object_pairs_hook`` that rejects duplicate keys and preserves order."""
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise JsonParseError(f"duplicate object key {json.dumps(key)}")
        result[key] = value
    return result


def _reject_constant(token: str) -> Any:
    """``parse_constant`` hook: reject ``NaN``/``Infinity``/``-Infinity``."""
    raise JsonParseError(f"unsupported JSON constant {token!r}")


_DECODER = json.JSONDecoder(
    object_pairs_hook=_reject_duplicate_keys,
    parse_int=JsonNumber,
    parse_float=JsonNumber,
    parse_constant=_reject_constant,
)


def parse_json(text: str) -> Any:
    """Parse exactly one JSON document under the strict subset grammar.

    :param text: The complete JSON document text.
    :returns: The parsed tree (``None``/``bool``/:class:`JsonNumber`/``str``/
        ``list``/``dict``).
    :raises JsonParseError: On any malformed input, duplicate key, trailing
        content, or unsupported constant.
    """
    try:
        value, end = _DECODER.raw_decode(text)
    except JsonParseError:
        raise
    except (json.JSONDecodeError, ValueError) as err:
        raise JsonParseError(f"malformed JSON: {err}") from err
    # Reject trailing non-whitespace content (mirror of parseDocument()).
    if text[end:].strip() != "":
        raise JsonParseError("unexpected trailing content")
    return value


# --- serialization -----------------------------------------------------------

_SHORT_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


def json_string(value: str) -> str:
    """Serialize a string exactly as ``JSON.stringify`` would.

    Emits the short escapes for ``\\b \\t \\n \\f \\r \\" \\\\``, ``\\uXXXX`` with
    lowercase hex for any other C0 control character, and every other code point
    verbatim (so non-ASCII text becomes raw UTF-8 bytes once the line is
    encoded). This byte-for-byte matches the TypeScript serializer.
    """
    out = ['"']
    for char in value:
        code = ord(char)
        short = _SHORT_ESCAPES.get(code)
        if short is not None:
            out.append(short)
        elif code < 0x20:
            out.append("\\u%04x" % code)
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def has_lone_surrogate(text: str) -> bool:
    """Whether ``text`` contains any unpaired UTF-16 surrogate code point.

    In Python a well-formed astral character is a single code point outside the
    surrogate range, so any code point in ``U+D800..U+DFFF`` is inherently lone
    and cannot be encoded as valid UTF-8. This mirrors the intent of
    ``hasLoneSurrogate`` in the TypeScript codec.
    """
    return any(0xD800 <= ord(char) <= 0xDFFF for char in text)
