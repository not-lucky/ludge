"""The ``tagged-jsonl-v1`` canonical codec, mirrored in Python.

This package is the byte-exact Python counterpart of ``src/judging/codec`` in
TypeScript. It converts between the canonical JSON Lines wire form and native
Python objects so a target solution can be driven across the process boundary
with byte-equality judging intact.
"""

from __future__ import annotations

from .decode import (
    CanonicalValidationError,
    ClassTrace,
    ClassTraceOperation,
    build_value,
)
from .encode import CodecEncodeError, encode_value
from .grammar import MAX_PAYLOAD_BYTES, Budget
from .jsonio import JsonParseError, parse_json

__all__ = [
    "Budget",
    "MAX_PAYLOAD_BYTES",
    "CanonicalValidationError",
    "CodecEncodeError",
    "ClassTrace",
    "ClassTraceOperation",
    "JsonParseError",
    "build_value",
    "encode_value",
    "parse_json",
]
