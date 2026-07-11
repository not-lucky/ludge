"""The Palestra Python harness entrypoint.

``uv run --no-project --python <python> __main__.py --role <role> --impl <path>
--entry <symbol>`` launches this module inside the isolated child process. It:

1. parses ``--role``/``--impl``/``--entry``;
2. reads exactly one request line from stdin, then EOF;
3. decodes the canonical request, dispatches to :mod:`runner`, and encodes one
   canonical response line;
4. writes that single line to stdout and flushes.

Contract: a well-formed run emits exactly one response line and exits ``0`` — a
response whose payload is either the target's ``output`` or, if the target
raised, a canonical ``exception`` value. Any *harness* fault (malformed request,
protocol violation, unresolved module/symbol) writes a bounded diagnostic to
stderr and exits non-zero **without** emitting a response line, which the
supervising process classifies as ``protocol_error``. Diagnostics never go to
stdout, and stdout is never used for anything but the one response line.
"""

from __future__ import annotations

import argparse
import sys

from protocol import ProtocolError, decode_request, encode_response_line
from runner import HarnessError, run

#: Exit code for a harness-side protocol/setup failure (no response emitted).
_EXIT_HARNESS_ERROR = 1

#: The maximum length of a diagnostic written to stderr, to keep faults bounded.
_MAX_DIAGNOSTIC_CHARS = 2000


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="palestra-harness",
        add_help=False,
        description="Palestra Python execution harness.",
    )
    parser.add_argument("--role", required=True, choices=["solution", "naive", "generator"])
    parser.add_argument("--impl", required=True)
    parser.add_argument("--entry", required=True)
    return parser.parse_args(argv)


def _fail(message: str) -> int:
    """Write a bounded diagnostic to stderr and return the harness-error code."""
    text = message if len(message) <= _MAX_DIAGNOSTIC_CHARS else message[:_MAX_DIAGNOSTIC_CHARS]
    print(text, file=sys.stderr, flush=True)
    return _EXIT_HARNESS_ERROR


def main(argv: list[str]) -> int:
    """Run one request/response cycle. Returns the process exit code."""
    try:
        args = _parse_args(argv)
    except SystemExit:
        # argparse already reported the usage error to stderr.
        return _EXIT_HARNESS_ERROR

    raw = sys.stdin.buffer.read()

    try:
        request = decode_request(raw)
    except ProtocolError as err:
        return _fail(f"protocol error: {err}")

    try:
        outcome = run(request, args.role, args.impl, args.entry)
    except HarnessError as err:
        return _fail(f"harness error: {err}")

    try:
        if outcome.is_exception:
            line = encode_response_line(request, exception=outcome.value)
        else:
            line = encode_response_line(request, output=outcome.value)
    except Exception as err:  # noqa: BLE001 - a non-encodable result is a harness fault
        return _fail(f"response encoding error: {err}")

    sys.stdout.buffer.write(line)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
