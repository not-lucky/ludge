"""Native Python objects -> canonical ``tagged-jsonl-v1`` JSON text.

Mirror of ``src/judging/codec/encode.ts``. :func:`encode_value` is the
authoritative Python side of the wire form: object keys are emitted in UTF-8
lexical order, ``set``/``frozenset`` items and ``dict`` entries are sorted (and
de-duplicated) by canonical encoded bytes, and every leaf is validated against
its normative grammar before emission. Equal values therefore serialize to
byte-identical output, matching the TypeScript encoder so byte-equality judging
holds across the process boundary.

Encoding is strict: a non-representable value (NaN/Infinity float, non-canonical
leaf, reference cycle, duplicate set/dict member, or exceeded limit) raises
:class:`CodecEncodeError`.
"""

from __future__ import annotations

import dataclasses
import math
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from pathlib import PurePath, PureWindowsPath
from typing import Any
from uuid import UUID

from . import grammar
from .adapters import ListNode, TreeNode, list_to_canonical, tree_to_canonical
from .grammar import Budget, LimitExceededError
from .jsonio import has_lone_surrogate, json_string


class CodecEncodeError(Exception):
    """Raised when a native value cannot be canonically encoded."""

    def __init__(self, message: str, path: str = "$") -> None:
        super().__init__(message)
        self.path = path


def encode_value(value: Any, budget: Budget | None = None) -> str:
    """Encode a native value to its canonical JSON text (no trailing newline).

    :param value: The native Python value to encode.
    :param budget: Optional depth/node accountant; a fresh one is used if omitted.
    :raises CodecEncodeError: If the value is not canonically encodable.
    """
    accountant = budget if budget is not None else Budget()
    try:
        return _encode_node(value, accountant, set(), "$")
    except LimitExceededError as err:
        raise CodecEncodeError(str(err)) from err


def _obj(pairs: list[tuple[str, str]]) -> str:
    """Assemble a JSON object from ``(key, encoded_value)`` pairs.

    Keys are emitted in UTF-8 byte order (Python ``bytes`` comparison is
    lexicographic, matching ``compareUtf8``); the values are already-encoded JSON
    fragments.
    """
    pairs.sort(key=lambda pair: pair[0].encode("utf-8"))
    return "{" + ",".join(f"{json_string(k)}:{v}" for k, v in pairs) + "}"


def _encode_node(value: Any, budget: Budget, seen: set[int], path: str) -> str:
    budget.count_node()

    if value is None:
        return '{"tag":"null"}'
    if isinstance(value, bool):
        return _obj([("tag", '"bool"'), ("value", "true" if value else "false")])
    if isinstance(value, Enum):
        return _encode_enum(value, budget, seen, path)
    if isinstance(value, int):
        return _obj([("tag", '"int"'), ("value", _encode_int(value))])
    if isinstance(value, float):
        return _encode_float(value, path)
    if isinstance(value, Decimal):
        return _encode_decimal(value, path)
    if isinstance(value, complex):
        return _obj(
            [
                ("imag", _encode_float(value.imag, f"{path}.imag")),
                ("real", _encode_float(value.real, f"{path}.real")),
                ("tag", '"complex"'),
            ]
        )
    if isinstance(value, str):
        return _obj([("tag", '"str"'), ("value", _encode_str(value, path))])
    if isinstance(value, (bytes, bytearray)):
        return _encode_bytes(bytes(value), path)
    if isinstance(value, ListNode):
        return _encode_list_node(value, budget, seen, path)
    if isinstance(value, TreeNode):
        return _encode_tree_node(value, budget, seen, path)
    if isinstance(value, datetime):
        return _encode_datetime(value, path)
    if isinstance(value, date):
        return _encode_date(value, path)
    if isinstance(value, time):
        return _encode_time(value, path)
    if isinstance(value, UUID):
        return _encode_uuid(value, path)
    if isinstance(value, PurePath):
        return _encode_path(value, path)
    if _is_namedtuple(value):
        return _encode_record(value, "namedtuple", type(value).__name__, list(value._fields), list(value), budget, seen, path)
    if isinstance(value, tuple):
        return _encode_sequence("tuple", list(value), budget, seen, path)
    if isinstance(value, list):
        return _encode_sequence("list", value, budget, seen, path)
    if isinstance(value, frozenset):
        return _encode_set("frozenset", value, budget, seen, path)
    if isinstance(value, set):
        return _encode_set("set", value, budget, seen, path)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        fields = dataclasses.fields(value)
        names = [f.name for f in fields]
        values = [getattr(value, f.name) for f in fields]
        return _encode_record(value, "dataclass", type(value).__name__, names, values, budget, seen, path)
    if isinstance(value, dict):
        return _encode_dict(value, budget, seen, path)
    if isinstance(value, BaseException):
        return _encode_exception(value, budget, seen, path)
    raise CodecEncodeError(f"unsupported value of type {type(value).__name__}", path)


def _is_namedtuple(value: Any) -> bool:
    """Whether ``value`` is a namedtuple instance (a tuple carrying ``_fields``)."""
    return isinstance(value, tuple) and hasattr(value, "_fields")


def _encode_int(value: int) -> str:
    if -grammar.MAX_SAFE_INT <= value <= grammar.MAX_SAFE_INT:
        return str(value)
    return json_string(str(value))


def _encode_float(value: float, path: str) -> str:
    if math.isnan(value) or math.isinf(value):
        raise CodecEncodeError("non-canonical or non-finite float", path)
    negative_zero = value == 0.0 and math.copysign(1.0, value) < 0.0
    text = grammar.canonical_float_text(value)
    if not grammar.is_canonical_float(text, negative_zero):
        raise CodecEncodeError("non-canonical or non-finite float", path)
    return _obj(
        [
            ("negativeZero", "true" if negative_zero else "false"),
            ("tag", '"float"'),
            ("value", json_string(text)),
        ]
    )


def _encode_decimal(value: Decimal, path: str) -> str:
    if not value.is_finite():
        raise CodecEncodeError("non-finite decimal", path)
    text = str(value)
    if not grammar.is_valid_decimal_literal(text):
        raise CodecEncodeError("invalid decimal literal", path)
    return _obj([("tag", '"decimal"'), ("value", json_string(text))])


def _encode_str(value: str, path: str) -> str:
    if has_lone_surrogate(value):
        raise CodecEncodeError("string contains a lone surrogate", path)
    return json_string(value)


def _encode_bytes(value: bytes, path: str) -> str:
    return _obj(
        [
            ("encoding", '"base64url"'),
            ("tag", '"bytes"'),
            ("value", json_string(grammar.encode_base64url(value))),
        ]
    )


def _encode_date(value: date, path: str) -> str:
    text = value.isoformat()
    if not grammar.is_valid_date(text):
        raise CodecEncodeError("invalid date", path)
    return _obj([("tag", '"date"'), ("value", json_string(text))])


def _time_text(value: time) -> str:
    """Render a ``time``'s wall-clock text ``HH:MM:SS[.ffffff]`` (no offset)."""
    text = f"{value.hour:02d}:{value.minute:02d}:{value.second:02d}"
    if value.microsecond:
        text += f".{value.microsecond:06d}"
    return text


def _offset_minutes(utc_offset: Any) -> int | None:
    """Convert a ``timedelta`` UTC offset to whole minutes, or ``None``."""
    if utc_offset is None:
        return None
    total_seconds = int(utc_offset.total_seconds())
    return total_seconds // 60


def _encode_time(value: time, path: str) -> str:
    text = _time_text(value)
    if not grammar.is_valid_time_of_day(text):
        raise CodecEncodeError("invalid time", path)
    offset = _offset_minutes(value.utcoffset())
    if offset is not None and not grammar.is_valid_offset_minutes(offset):
        raise CodecEncodeError("offsetMinutes out of range", path)
    return _obj(
        [
            ("fold", str(value.fold)),
            ("offsetMinutes", "null" if offset is None else str(offset)),
            ("tag", '"time"'),
            ("value", json_string(text)),
        ]
    )


def _encode_datetime(value: datetime, path: str) -> str:
    text = f"{value.date().isoformat()}T{_time_text(value.timetz())}"
    if not grammar.is_valid_datetime_text(text):
        raise CodecEncodeError("invalid datetime", path)
    offset = _offset_minutes(value.utcoffset())
    if offset is None:
        raise CodecEncodeError("naive datetime is not representable", path)
    if not grammar.is_valid_offset_minutes(offset):
        raise CodecEncodeError("offsetMinutes out of range", path)
    return _obj(
        [
            ("fold", str(value.fold)),
            ("offsetMinutes", str(offset)),
            ("tag", '"datetime"'),
            ("value", json_string(text)),
        ]
    )


def _encode_uuid(value: UUID, path: str) -> str:
    text = str(value)
    if not grammar.is_valid_uuid(text):
        raise CodecEncodeError("invalid uuid", path)
    return _obj([("tag", '"uuid"'), ("value", json_string(text))])


def _encode_path(value: PurePath, path: str) -> str:
    flavor = "windows" if isinstance(value, PureWindowsPath) else "posix"
    text = str(value)
    if not grammar.is_canonical_relative_path(text, flavor):
        raise CodecEncodeError("invalid or absolute path", path)
    return _obj(
        [
            ("flavor", json_string(flavor)),
            ("tag", '"path"'),
            ("value", json_string(text)),
        ]
    )


def _encode_sequence(tag: str, items: list[Any], budget: Budget, seen: set[int], path: str) -> str:
    with _container(items, seen, path):
        budget.enter()
        parts = [_encode_node(item, budget, seen, f"{path}.items[{i}]") for i, item in enumerate(items)]
        budget.leave()
    return _obj([("items", "[" + ",".join(parts) + "]"), ("tag", json_string(tag))])


def _encode_set(tag: str, items: Any, budget: Budget, seen: set[int], path: str) -> str:
    with _container(items, seen, path):
        budget.enter()
        encoded = [_encode_node(item, budget, seen, f"{path}.items[{i}]") for i, item in enumerate(items)]
        budget.leave()
    encoded.sort(key=lambda text: text.encode("utf-8"))
    for i in range(1, len(encoded)):
        if encoded[i - 1] == encoded[i]:
            raise CodecEncodeError(f"duplicate {tag} member", path)
    return _obj([("items", "[" + ",".join(encoded) + "]"), ("tag", json_string(tag))])


def _encode_dict(value: dict[Any, Any], budget: Budget, seen: set[int], path: str) -> str:
    with _container(value, seen, path):
        budget.enter()
        entries: list[tuple[bytes, str]] = []
        for i, (key, val) in enumerate(value.items()):
            key_text = _encode_node(key, budget, seen, f"{path}.entries[{i}].key")
            val_text = _encode_node(val, budget, seen, f"{path}.entries[{i}].value")
            entry = _obj([("key", key_text), ("value", val_text)])
            entries.append((key_text.encode("utf-8"), entry))
        budget.leave()
    entries.sort(key=lambda pair: pair[0])
    for i in range(1, len(entries)):
        if entries[i - 1][0] == entries[i][0]:
            raise CodecEncodeError("duplicate dict key", path)
    return _obj([("entries", "[" + ",".join(entry for _, entry in entries) + "]"), ("tag", '"dict"')])


def _encode_record(
    node: Any,
    record_type: str,
    name: str,
    names: list[str],
    values: list[Any],
    budget: Budget,
    seen: set[int],
    path: str,
) -> str:
    with _container(node, seen, path):
        budget.enter()
        seen_names: set[str] = set()
        fields: list[str] = []
        for i, (field_name, field_value) in enumerate(zip(names, values)):
            if field_name in seen_names:
                raise CodecEncodeError("duplicate record field name", path)
            seen_names.add(field_name)
            fields.append(
                _obj(
                    [
                        ("name", _encode_str(field_name, f"{path}.fields[{i}].name")),
                        ("value", _encode_node(field_value, budget, seen, f"{path}.fields[{i}].value")),
                    ]
                )
            )
        budget.leave()
    return _obj(
        [
            ("fields", "[" + ",".join(fields) + "]"),
            ("name", _encode_str(name, f"{path}.name")),
            ("tag", '"record"'),
            ("type", json_string(record_type)),
        ]
    )


def _encode_exception(value: BaseException, budget: Budget, seen: set[int], path: str) -> str:
    with _container(value, seen, path):
        details_value = getattr(value, "details", None)
        details = "null" if details_value is None else _encode_node(details_value, budget, seen, f"{path}.details")
    return _obj(
        [
            ("details", details),
            ("message", _encode_str(str(value), f"{path}.message")),
            ("tag", '"exception"'),
            ("type", _encode_str(type(value).__name__, f"{path}.type")),
        ]
    )


def _encode_list_node(value: ListNode, budget: Budget, seen: set[int], path: str) -> str:
    with _container(value, seen, path):
        values, cycle_index = list_to_canonical(value)
        budget.enter()
        encoded = [_encode_node(v, budget, seen, f"{path}.values[{i}]") for i, v in enumerate(values)]
        budget.leave()
    return _obj(
        [
            ("cycleIndex", "null" if cycle_index is None else str(cycle_index)),
            ("tag", '"ListNode"'),
            ("values", "[" + ",".join(encoded) + "]"),
        ]
    )


def _encode_tree_node(value: TreeNode, budget: Budget, seen: set[int], path: str) -> str:
    with _container(value, seen, path):
        slots = tree_to_canonical(value)
        budget.enter()
        parts = [
            "null" if slot is None else _encode_node(slot, budget, seen, f"{path}.values[{i}]")
            for i, slot in enumerate(slots)
        ]
        budget.leave()
    return _obj([("tag", '"TreeNode"'), ("values", "[" + ",".join(parts) + "]")])


class _container:
    """Context manager pushing a container onto the cycle-detection set."""

    __slots__ = ("_node_id", "_seen", "_path")

    def __init__(self, node: Any, seen: set[int], path: str) -> None:
        self._node_id = id(node)
        self._seen = seen
        self._path = path

    def __enter__(self) -> "_container":
        if self._node_id in self._seen:
            raise CodecEncodeError("reference cycle detected", self._path)
        self._seen.add(self._node_id)
        return self

    def __exit__(self, *exc: Any) -> None:
        self._seen.discard(self._node_id)
