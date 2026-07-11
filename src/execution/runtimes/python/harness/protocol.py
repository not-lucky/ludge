"""JSON Lines request/response envelope framing.

Mirror of ``src/judging/codec/envelope.ts``. The transport carries exactly one
request line on stdin (then EOF) and exactly one response line on stdout (then
EOF). Each line is a single JSON object with ``protocolVersion: 1``, framing
metadata, and a canonical value payload.

Ordering of the two limits is honored: the envelope's ``messageLimitBytes`` is
checked against the raw message BEFORE the value payload is decoded, while the
codec's payload limit is enforced by the value builder afterward. Any framing or
validation failure is a protocol error; stderr is never parsed as protocol data.
"""

from __future__ import annotations

import re
from typing import Any

from canonical import (
    Budget,
    CanonicalValidationError,
    JsonParseError,
    MAX_PAYLOAD_BYTES,
    build_value,
    encode_value,
    parse_json,
)
from canonical.jsonio import JsonNumber, json_string

#: The only protocol version this build produces and accepts.
PROTOCOL_VERSION = 1

#: The wire/version identifier this harness produces and accepts.
CODEC_VERSION = "tagged-jsonl-v1"

_CODEC_VERSION_RE = re.compile(r"^tagged-jsonl-v(\d+)(?:\.(\d+))?$")
_SUPPORTED_CODEC_MAJOR = 1
_POSITIVE_INT_RE = re.compile(r"^[1-9][0-9]*$")


class ProtocolError(Exception):
    """A framing/validation failure; always classified ``protocol_error``."""


class RequestEnvelope:
    """A decoded request: framing metadata plus one native input value."""

    __slots__ = ("run_id", "case_id", "codec_version", "message_limit_bytes", "input")

    def __init__(
        self,
        run_id: str,
        case_id: str,
        codec_version: str,
        message_limit_bytes: int,
        input_value: Any,
    ) -> None:
        self.run_id = run_id
        self.case_id = case_id
        self.codec_version = codec_version
        self.message_limit_bytes = message_limit_bytes
        self.input = input_value


def _is_supported_codec_version(version: str) -> bool:
    match = _CODEC_VERSION_RE.match(version)
    return match is not None and int(match.group(1)) == _SUPPORTED_CODEC_MAJOR


def _frame_to_object(raw: bytes) -> dict[str, Any]:
    """Decode bytes, extract the single line, parse it, require a JSON object."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as err:
        raise ProtocolError("message is not valid UTF-8") from err
    line = _single_line(text)
    try:
        node = parse_json(line)
    except JsonParseError as err:
        raise ProtocolError(f"malformed envelope JSON: {err}") from err
    if not isinstance(node, dict):
        raise ProtocolError("envelope must be a JSON object")
    return node


def _single_line(text: str) -> str:
    """Extract exactly one non-empty line, allowing one optional trailing newline."""
    parts = text.split("\n")
    if len(parts) > 2 or (len(parts) == 2 and parts[1] != ""):
        raise ProtocolError("expected exactly one line then EOF")
    line = parts[0] if parts else ""
    if line == "":
        raise ProtocolError("empty envelope line")
    return line


def _require_protocol_version(members: dict[str, Any]) -> None:
    node = members.get("protocolVersion")
    if not isinstance(node, JsonNumber):
        raise ProtocolError("missing protocolVersion")
    if node.raw != str(PROTOCOL_VERSION):
        raise ProtocolError(f"unsupported protocolVersion {node.raw}")


def _require_kind(members: dict[str, Any], kind: str) -> None:
    node = members.get("kind")
    if not isinstance(node, str) or node != kind:
        raise ProtocolError(f"kind must be {kind!r}")


def _read_message_limit(members: dict[str, Any], message_bytes: int) -> int:
    node = members.get("messageLimitBytes")
    if not isinstance(node, JsonNumber) or _POSITIVE_INT_RE.match(node.raw) is None:
        raise ProtocolError("messageLimitBytes must be a positive integer")
    limit = int(node.raw)
    if limit > MAX_PAYLOAD_BYTES:
        raise ProtocolError(f"messageLimitBytes exceeds {MAX_PAYLOAD_BYTES}")
    if message_bytes > limit:
        raise ProtocolError("message exceeds messageLimitBytes")
    return limit


def _non_empty_string(members: dict[str, Any], key: str) -> str:
    node = members.get(key)
    if not isinstance(node, str) or node == "":
        raise ProtocolError(f"{key} must be a non-empty string")
    return node


def _exact_fields(members: dict[str, Any], allowed: tuple[str, ...]) -> None:
    for key in members:
        if key not in allowed:
            raise ProtocolError(f"unknown envelope field {key!r}")
    for key in allowed:
        if key not in members:
            raise ProtocolError(f"missing envelope field {key!r}")


def _build_or_reject(node: Any) -> Any:
    try:
        return build_value(node, Budget())
    except CanonicalValidationError as err:
        raise ProtocolError(err.args[0] if err.args else "invalid canonical value") from err


def decode_request(raw: bytes) -> RequestEnvelope:
    """Decode and validate a request envelope from a framed line.

    :param raw: The raw request bytes (one line, optional trailing newline).
    :returns: The decoded :class:`RequestEnvelope`.
    :raises ProtocolError: On any framing or payload validation failure.
    """
    members = _frame_to_object(raw)
    _require_protocol_version(members)
    _require_kind(members, "request")
    message_limit = _read_message_limit(members, len(raw))
    run_id = _non_empty_string(members, "runId")
    case_id = _non_empty_string(members, "caseId")
    codec_version = _non_empty_string(members, "codecVersion")
    if not _is_supported_codec_version(codec_version):
        raise ProtocolError("unsupported codec version")
    _exact_fields(
        members,
        (
            "caseId",
            "codecVersion",
            "input",
            "kind",
            "messageLimitBytes",
            "protocolVersion",
            "runId",
        ),
    )
    input_value = _build_or_reject(members["input"])
    return RequestEnvelope(run_id, case_id, codec_version, message_limit, input_value)


_UNSET = object()


def encode_response_line(
    request: RequestEnvelope,
    *,
    output: Any = _UNSET,
    exception: Any = _UNSET,
) -> bytes:
    """Encode a response envelope to a single newline-terminated JSON Lines record.

    Exactly one of ``output`` / ``exception`` must be supplied. The response
    echoes the request's ``runId``/``caseId``/``codecVersion``/``messageLimitBytes``
    so the supervising process can match it. Field order matches the TypeScript
    encoder's fixed, already-sorted key order.

    :param request: The originating request whose identity is echoed.
    :param output: The native output value, when the target returned a value.
    :param exception: The native exception value, when the target raised.
    :returns: The UTF-8 bytes of the framed response line (with trailing newline).
    """
    has_output = output is not _UNSET
    has_exception = exception is not _UNSET
    if has_output == has_exception:
        raise ValueError("response must carry exactly one of output/exception")
    output_text = encode_value(output) if has_output else "null"
    exception_text = encode_value(exception) if has_exception else "null"
    line = "{" + ",".join(
        [
            f'"caseId":{json_string(request.case_id)}',
            f'"codecVersion":{json_string(request.codec_version)}',
            f'"exception":{exception_text}',
            '"kind":"response"',
            f'"messageLimitBytes":{request.message_limit_bytes}',
            f'"output":{output_text}',
            f'"protocolVersion":{PROTOCOL_VERSION}',
            f'"runId":{json_string(request.run_id)}',
        ]
    ) + "}"
    return (line + "\n").encode("utf-8")
