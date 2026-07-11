"""Canonical wire JSON -> native Python objects.

Mirror of ``src/judging/codec/decode.ts``. :func:`build_value` validates a
parsed JSON tree (see :mod:`.jsonio`) against the normative value model and
materializes it as ordinary Python objects the target solution can consume:
``None``/``bool``/``int``/``float``/``Decimal``/``complex``/``str``/``list``/
``tuple``/``set``/``frozenset``/``dict``/``bytes``/``date``/``time``/``datetime``/
``UUID``/``PurePath``, plus the ``ListNode``/``TreeNode`` adapters and a
:class:`ClassTrace` descriptor.

Two documented simplifications versus the TypeScript model, made because the
harness must never import user modules to reconstruct types:

* an ``enum`` value decodes to its underlying value;
* a ``record`` value decodes to a dynamically-built namedtuple (or a plain dict
  when the field names are not valid identifiers).

The decoder trusts that its input is canonical: it is always produced by the
authoritative TypeScript codec, so it does not re-verify set/dict ordering
(that ordering is reconstructed deterministically on re-encode instead).
"""

from __future__ import annotations

import collections
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any
from uuid import UUID

from . import grammar
from .adapters import build_list, build_tree
from .grammar import Budget
from .jsonio import JsonNumber, has_lone_surrogate


class CanonicalValidationError(Exception):
    """Raised when a JSON tree is not a canonical value."""

    def __init__(self, message: str, path: str = "$") -> None:
        super().__init__(message)
        self.path = path


class ClassTraceOperation:
    """One method invocation within a :class:`ClassTrace`."""

    __slots__ = ("method", "args", "has_expected", "expected")

    def __init__(
        self,
        method: str,
        args: list[Any],
        has_expected: bool,
        expected: Any,
    ) -> None:
        self.method = method
        self.args = args
        self.has_expected = has_expected
        self.expected = expected


class ClassTrace:
    """A decoded stateful-class interaction trace.

    The runner constructs ``class_name`` with ``constructor`` args once, then
    applies ``operations`` in order.
    """

    __slots__ = ("class_name", "constructor", "operations")

    def __init__(
        self,
        class_name: str,
        constructor: list[Any],
        operations: list[ClassTraceOperation],
    ) -> None:
        self.class_name = class_name
        self.constructor = constructor
        self.operations = operations


def build_value(node: Any, budget: Budget) -> Any:
    """Build a validated native value from a parsed JSON tree.

    :param node: The root parsed JSON node.
    :param budget: Depth/node accountant for this decode traversal.
    :returns: The native Python value.
    :raises CanonicalValidationError: If the tree is not a canonical value.
    """
    return _build(node, budget, "$")


# --- structural helpers ------------------------------------------------------


def _as_object(node: Any, path: str) -> dict[str, Any]:
    if not isinstance(node, dict):
        raise CanonicalValidationError("expected a tagged object", path)
    return node


def _tag_of(members: dict[str, Any], path: str) -> str:
    tag = members.get("tag")
    if not isinstance(tag, str):
        raise CanonicalValidationError("missing or non-string tag", path)
    return tag


def _fields(
    members: dict[str, Any],
    path: str,
    allowed: tuple[str, ...],
    optional: tuple[str, ...] = (),
) -> None:
    for key in members:
        if key not in allowed and key not in optional:
            raise CanonicalValidationError(f"forbidden field {key!r}", path)
    for key in allowed:
        if key not in members:
            raise CanonicalValidationError(f"missing field {key!r}", path)


def _req(members: dict[str, Any], key: str, path: str) -> Any:
    if key not in members:
        raise CanonicalValidationError(f"missing field {key!r}", path)
    return members[key]


def _arr_of(node: Any, path: str) -> list[Any]:
    if not isinstance(node, list):
        raise CanonicalValidationError("expected an array", path)
    return node


def _bool_of(node: Any, path: str) -> bool:
    if not isinstance(node, bool):
        raise CanonicalValidationError("expected a boolean", path)
    return node


def _str_of(node: Any, path: str) -> str:
    if not isinstance(node, str):
        raise CanonicalValidationError("expected a string", path)
    if has_lone_surrogate(node):
        raise CanonicalValidationError("string contains a lone surrogate", path)
    return node


def _raw_string_of(node: Any, path: str) -> str:
    if not isinstance(node, str):
        raise CanonicalValidationError("expected a string", path)
    return node


def _non_empty_str_of(node: Any, path: str) -> str:
    value = _str_of(node, path)
    if value == "":
        raise CanonicalValidationError("expected a non-empty string", path)
    return value


def _int_of(node: Any, path: str) -> int:
    if isinstance(node, JsonNumber):
        if not grammar.is_canonical_int_string(node.raw):
            raise CanonicalValidationError("int number must be an integer", path)
        value = int(node.raw)
        if value < -grammar.MAX_SAFE_INT or value > grammar.MAX_SAFE_INT:
            raise CanonicalValidationError(
                "out-of-range int must be a decimal string", path
            )
        return value
    if isinstance(node, str):
        if not grammar.is_canonical_int_string(node):
            raise CanonicalValidationError("invalid int string", path)
        value = int(node)
        if -grammar.MAX_SAFE_INT <= value <= grammar.MAX_SAFE_INT:
            raise CanonicalValidationError("safe-range int must be a JSON number", path)
        return value
    raise CanonicalValidationError("expected an int number or string", path)


def _leaf_number(node: Any, budget: Budget, path: str) -> float:
    """Build a numeric leaf and coerce it to a ``float`` for a complex part."""
    value = _build(node, budget, path)
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise CanonicalValidationError("expected a numeric leaf", path)
    return float(value)


# --- recursive worker --------------------------------------------------------


def _build(node: Any, budget: Budget, path: str) -> Any:
    budget.count_node()
    members = _as_object(node, path)
    tag = _tag_of(members, path)

    if tag == "null":
        _fields(members, path, ("tag",))
        return None
    if tag == "bool":
        _fields(members, path, ("tag", "value"))
        return _bool_of(_req(members, "value", path), path)
    if tag == "int":
        _fields(members, path, ("tag", "value"))
        return _int_of(_req(members, "value", path), path)
    if tag == "float":
        _fields(members, path, ("tag", "value", "negativeZero"))
        value = _raw_string_of(_req(members, "value", path), path)
        negative_zero = _bool_of(_req(members, "negativeZero", path), path)
        if not grammar.is_canonical_float(value, negative_zero):
            raise CanonicalValidationError("non-canonical float", path)
        return -0.0 if negative_zero else float(value)
    if tag == "decimal":
        _fields(members, path, ("tag", "value"))
        value = _raw_string_of(_req(members, "value", path), path)
        if not grammar.is_valid_decimal_literal(value):
            raise CanonicalValidationError("invalid decimal literal", path)
        return Decimal(value)
    if tag == "complex":
        _fields(members, path, ("tag", "real", "imag"))
        real = _leaf_number(_req(members, "real", path), budget, f"{path}.real")
        imag = _leaf_number(_req(members, "imag", path), budget, f"{path}.imag")
        return complex(real, imag)
    if tag == "str":
        _fields(members, path, ("tag", "value"))
        return _str_of(_req(members, "value", path), path)
    if tag in ("list", "tuple"):
        _fields(members, path, ("tag", "items"))
        items = _build_items(_req(members, "items", path), budget, path)
        return items if tag == "list" else tuple(items)
    if tag in ("set", "frozenset"):
        _fields(members, path, ("tag", "items"))
        items = _build_items(_req(members, "items", path), budget, path)
        return set(items) if tag == "set" else frozenset(items)
    if tag == "dict":
        return _build_dict(members, budget, path)
    if tag == "bytes":
        return _build_bytes(members, path)
    if tag == "date":
        _fields(members, path, ("tag", "value"))
        value = _raw_string_of(_req(members, "value", path), path)
        if not grammar.is_valid_date(value):
            raise CanonicalValidationError("invalid date", path)
        return date.fromisoformat(value)
    if tag == "time":
        return _build_time(members, path)
    if tag == "datetime":
        return _build_datetime(members, path)
    if tag == "uuid":
        _fields(members, path, ("tag", "value"))
        value = _raw_string_of(_req(members, "value", path), path)
        if not grammar.is_valid_uuid(value):
            raise CanonicalValidationError("invalid uuid", path)
        return UUID(value)
    if tag == "path":
        return _build_path(members, path)
    if tag == "enum":
        return _build_enum(members, budget, path)
    if tag == "record":
        return _build_record(members, budget, path)
    if tag == "exception":
        return _build_exception(members, budget, path)
    if tag == "ListNode":
        return _build_list_node(members, budget, path)
    if tag == "TreeNode":
        return _build_tree_node(members, budget, path)
    if tag == "ClassTrace":
        return _build_class_trace(members, budget, path)
    raise CanonicalValidationError(f"unknown tag {tag!r}", path)


def _build_items(node: Any, budget: Budget, path: str) -> list[Any]:
    items = _arr_of(node, path)
    budget.enter()
    built = [_build(item, budget, f"{path}.items[{i}]") for i, item in enumerate(items)]
    budget.leave()
    return built


def _build_dict(members: dict[str, Any], budget: Budget, path: str) -> dict[Any, Any]:
    _fields(members, path, ("tag", "entries"))
    raw_entries = _arr_of(_req(members, "entries", path), path)
    budget.enter()
    result: dict[Any, Any] = {}
    for i, entry_node in enumerate(raw_entries):
        entry_path = f"{path}.entries[{i}]"
        entry = _as_object(entry_node, entry_path)
        _fields(entry, entry_path, ("key", "value"))
        key = _build(_req(entry, "key", entry_path), budget, f"{entry_path}.key")
        value = _build(_req(entry, "value", entry_path), budget, f"{entry_path}.value")
        result[key] = value
    budget.leave()
    return result


def _build_bytes(members: dict[str, Any], path: str) -> bytes:
    _fields(members, path, ("tag", "encoding", "value"))
    encoding = _raw_string_of(_req(members, "encoding", path), path)
    if encoding != "base64url":
        raise CanonicalValidationError("unsupported bytes encoding", path)
    value = _raw_string_of(_req(members, "value", path), path)
    decoded = grammar.decode_base64url(value)
    if decoded is None:
        raise CanonicalValidationError("invalid base64url", path)
    return decoded


def _offset_of(node: Any, path: str, nullable: bool) -> int | None:
    if node is None:
        if not nullable:
            raise CanonicalValidationError("offsetMinutes must not be null", path)
        return None
    if not isinstance(node, JsonNumber) or not grammar.is_canonical_int_string(node.raw):
        raise CanonicalValidationError("offsetMinutes must be an integer", path)
    value = int(node.raw)
    if not grammar.is_valid_offset_minutes(value):
        raise CanonicalValidationError("offsetMinutes out of range", path)
    return value


def _fold_of(node: Any, path: str) -> int:
    if isinstance(node, JsonNumber) and node.raw in ("0", "1"):
        return int(node.raw)
    raise CanonicalValidationError("fold must be 0 or 1", path)


def _parse_time_components(value: str) -> tuple[int, int, int, int]:
    """Split ``HH:MM:SS[.ffffff]`` into hour, minute, second, microsecond."""
    clock, _, fraction = value.partition(".")
    hour, minute, second = (int(part) for part in clock.split(":"))
    microsecond = int((fraction + "000000")[:6]) if fraction else 0
    return hour, minute, second, microsecond


def _build_time(members: dict[str, Any], path: str) -> time:
    _fields(members, path, ("tag", "value", "offsetMinutes", "fold"))
    value = _raw_string_of(_req(members, "value", path), path)
    if not grammar.is_valid_time_of_day(value):
        raise CanonicalValidationError("invalid time", path)
    offset = _offset_of(_req(members, "offsetMinutes", path), path, True)
    fold = _fold_of(_req(members, "fold", path), path)
    hour, minute, second, microsecond = _parse_time_components(value)
    tzinfo = None if offset is None else timezone(timedelta(minutes=offset))
    return time(hour, minute, second, microsecond, tzinfo=tzinfo, fold=fold)


def _build_datetime(members: dict[str, Any], path: str) -> datetime:
    _fields(members, path, ("tag", "value", "offsetMinutes", "fold"))
    value = _raw_string_of(_req(members, "value", path), path)
    if not grammar.is_valid_datetime_text(value):
        raise CanonicalValidationError("invalid datetime", path)
    offset = _offset_of(_req(members, "offsetMinutes", path), path, False)
    if offset is None:
        raise CanonicalValidationError("datetime requires an offset", path)
    fold = _fold_of(_req(members, "fold", path), path)
    date_part, _, time_part = value.partition("T")
    year, month, day = (int(part) for part in date_part.split("-"))
    hour, minute, second, microsecond = _parse_time_components(time_part)
    return datetime(
        year,
        month,
        day,
        hour,
        minute,
        second,
        microsecond,
        tzinfo=timezone(timedelta(minutes=offset)),
        fold=fold,
    )


def _build_path(members: dict[str, Any], path: str) -> Any:
    _fields(members, path, ("tag", "value", "flavor"))
    flavor = _raw_string_of(_req(members, "flavor", path), path)
    if flavor not in ("posix", "windows"):
        raise CanonicalValidationError("invalid path flavor", path)
    value = _raw_string_of(_req(members, "value", path), path)
    if not grammar.is_canonical_relative_path(value, flavor):
        raise CanonicalValidationError("invalid or absolute path", path)
    return PurePosixPath(value) if flavor == "posix" else PureWindowsPath(value)


def _build_enum(members: dict[str, Any], budget: Budget, path: str) -> Any:
    _fields(members, path, ("tag", "type", "member", "value"))
    _non_empty_str_of(_req(members, "type", path), f"{path}.type")
    _non_empty_str_of(_req(members, "member", path), f"{path}.member")
    budget.enter()
    value = _build(_req(members, "value", path), budget, f"{path}.value")
    budget.leave()
    # Documented simplification: an enum decodes to its underlying value.
    return value


def _build_record(members: dict[str, Any], budget: Budget, path: str) -> Any:
    _fields(members, path, ("tag", "type", "name", "fields"))
    record_type = _raw_string_of(_req(members, "type", path), path)
    if record_type not in ("dataclass", "namedtuple"):
        raise CanonicalValidationError("invalid record type", path)
    name = _non_empty_str_of(_req(members, "name", path), f"{path}.name")
    raw_fields = _arr_of(_req(members, "fields", path), path)
    seen: set[str] = set()
    names: list[str] = []
    values: list[Any] = []
    budget.enter()
    for i, field_node in enumerate(raw_fields):
        field_path = f"{path}.fields[{i}]"
        field = _as_object(field_node, field_path)
        _fields(field, field_path, ("name", "value"))
        field_name = _str_of(_req(field, "name", field_path), field_path)
        if field_name in seen:
            raise CanonicalValidationError("duplicate record field name", field_path)
        seen.add(field_name)
        names.append(field_name)
        values.append(_build(_req(field, "value", field_path), budget, f"{field_path}.value"))
    budget.leave()
    # Documented simplification: build a namedtuple; fall back to a dict when the
    # field names are not valid Python identifiers.
    try:
        factory = collections.namedtuple(name, names)  # type: ignore[misc]
    except ValueError:
        return dict(zip(names, values))
    return factory(*values)


def _build_exception(members: dict[str, Any], budget: Budget, path: str) -> Exception:
    _fields(members, path, ("tag", "type", "message", "details"))
    type_name = _non_empty_str_of(_req(members, "type", path), f"{path}.type")
    message = _str_of(_req(members, "message", path), f"{path}.message")
    details_node = _req(members, "details", path)
    budget.enter()
    details = None if details_node is None else _build(details_node, budget, f"{path}.details")
    budget.leave()
    exc = type(type_name, (Exception,), {})(message)
    exc.details = details  # type: ignore[attr-defined]
    return exc


def _nullable_index_of(node: Any, length: int, path: str) -> int | None:
    if node is None:
        return None
    if not isinstance(node, JsonNumber) or not grammar.is_canonical_int_string(node.raw):
        raise CanonicalValidationError("cycleIndex must be an integer", path)
    value = int(node.raw)
    if value < 0 or value >= length:
        raise CanonicalValidationError("cycleIndex out of range", path)
    return value


def _build_list_node(members: dict[str, Any], budget: Budget, path: str) -> Any:
    _fields(members, path, ("tag", "values", "cycleIndex"))
    raw_values = _arr_of(_req(members, "values", path), path)
    budget.enter()
    values = [_build(v, budget, f"{path}.values[{i}]") for i, v in enumerate(raw_values)]
    budget.leave()
    cycle_index = _nullable_index_of(_req(members, "cycleIndex", path), len(values), path)
    return build_list(values, cycle_index)


def _build_tree_node(members: dict[str, Any], budget: Budget, path: str) -> Any:
    _fields(members, path, ("tag", "values"))
    raw_values = _arr_of(_req(members, "values", path), path)
    if raw_values and _is_null(raw_values[-1]):
        raise CanonicalValidationError("TreeNode has trailing nulls (non-canonical)", path)
    for i, slot in enumerate(raw_values):
        if _is_null(slot):
            left = 2 * i + 1
            right = 2 * i + 2
            if (left < len(raw_values) and not _is_null(raw_values[left])) or (
                right < len(raw_values) and not _is_null(raw_values[right])
            ):
                raise CanonicalValidationError("unreachable TreeNode node", path)
    budget.enter()
    slots = [
        None if _is_null(slot) else _build(slot, budget, f"{path}.values[{i}]")
        for i, slot in enumerate(raw_values)
    ]
    budget.leave()
    return build_tree(slots)


def _is_null(node: Any) -> bool:
    """Whether a parsed JSON node is the ``null`` literal (not a tagged value)."""
    return node is None


def _build_class_trace(members: dict[str, Any], budget: Budget, path: str) -> ClassTrace:
    _fields(members, path, ("tag", "className", "constructor", "operations"))
    class_name = _non_empty_str_of(_req(members, "className", path), f"{path}.className")
    raw_ctor = _arr_of(_req(members, "constructor", path), path)
    raw_ops = _arr_of(_req(members, "operations", path), path)
    budget.enter()
    constructor = [_build(v, budget, f"{path}.constructor[{i}]") for i, v in enumerate(raw_ctor)]
    operations: list[ClassTraceOperation] = []
    for i, op_node in enumerate(raw_ops):
        op_path = f"{path}.operations[{i}]"
        op = _as_object(op_node, op_path)
        _fields(op, op_path, ("method", "args"), ("expected",))
        method = _non_empty_str_of(_req(op, "method", op_path), f"{op_path}.method")
        args = [
            _build(a, budget, f"{op_path}.args[{j}]")
            for j, a in enumerate(_arr_of(_req(op, "args", op_path), op_path))
        ]
        if "expected" in op:
            operations.append(
                ClassTraceOperation(method, args, True, _build(op["expected"], budget, f"{op_path}.expected"))
            )
        else:
            operations.append(ClassTraceOperation(method, args, False, None))
    budget.leave()
    return ClassTrace(class_name, constructor, operations)
