"""Target orchestration: import the implementation and invoke it.

The runner sits between the decoded request and the target implementation. It
imports the ``--impl`` module (never evaluating it inside the supervising
TypeScript process — this is already the isolated child), resolves the callable
or class, invokes it, and returns either the native result or the native
exception the target raised.

Three dispatch shapes are supported:

* a :class:`~canonical.ClassTrace` input drives a stateful class: the named class
  is constructed once with the constructor args, then each operation's method is
  called in order and its return collected, yielding a ``list`` of returns;
* the ``generator`` role derives a seeded :class:`random.Random` from the integer
  seed input and calls the entry with it (a minimal hook for differential
  fuzzing, task 14);
* otherwise the entry callable is invoked with the decoded input, spreading a
  top-level ``tuple`` as positional arguments and passing any other value as a
  single positional argument.

A distinction is enforced: failures to import the module or resolve the symbol
are harness errors (they propagate and become a ``protocol_error`` with no
response line), whereas an exception raised by the target itself is a normal
outcome returned as an ``exception`` response value.
"""

from __future__ import annotations

import importlib.util
import random
from pathlib import Path
from typing import Any

from canonical import ClassTrace
from protocol import RequestEnvelope

#: The module name the target implementation is loaded under.
_TARGET_MODULE_NAME = "palestra_target"


class HarnessError(Exception):
    """A harness-side failure (bad module, missing symbol): never a target result."""


class RunOutcome:
    """The result of running a target: either a return value or a raised exception."""

    __slots__ = ("is_exception", "value")

    def __init__(self, is_exception: bool, value: Any) -> None:
        self.is_exception = is_exception
        self.value = value


def run(request: RequestEnvelope, role: str, impl_path: str, entry_symbol: str) -> RunOutcome:
    """Import the target and invoke it for one request.

    :param request: The decoded request envelope.
    :param role: One of ``solution``/``naive``/``generator``.
    :param impl_path: Path to the target module, relative to the working directory.
    :param entry_symbol: The entry function name for non-``ClassTrace`` inputs.
    :returns: The :class:`RunOutcome` (value or captured exception).
    :raises HarnessError: If the module or entry symbol cannot be resolved.
    """
    module = _import_impl(impl_path)
    input_value = request.input

    if isinstance(input_value, ClassTrace):
        instance_class = _resolve(module, input_value.class_name)
        return _capture(lambda: _run_class_trace(instance_class, input_value))

    entry = _resolve(module, entry_symbol)
    if role == "generator":
        return _capture(lambda: _run_generator(entry, input_value))
    return _capture(lambda: _invoke(entry, input_value))


def _import_impl(impl_path: str) -> Any:
    """Load the target module from a filesystem path."""
    resolved = Path(impl_path).resolve()
    if not resolved.is_file():
        raise HarnessError(f"implementation not found: {impl_path}")
    spec = importlib.util.spec_from_file_location(_TARGET_MODULE_NAME, resolved)
    if spec is None or spec.loader is None:
        raise HarnessError(f"cannot load implementation: {impl_path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as err:  # noqa: BLE001 - surface any import-time failure as harness error
        raise HarnessError(f"error importing implementation: {err}") from err
    return module


def _resolve(module: Any, symbol: str) -> Any:
    """Resolve a named attribute (function or class) from the target module."""
    target = getattr(module, symbol, None)
    if target is None:
        raise HarnessError(f"symbol {symbol!r} not found in implementation")
    return target


def _invoke(entry: Any, input_value: Any) -> Any:
    """Invoke a plain entry callable, spreading a top-level tuple as positional args."""
    if isinstance(input_value, tuple):
        return entry(*input_value)
    return entry(input_value)


def _run_class_trace(instance_class: Any, trace: ClassTrace) -> list[Any]:
    """Construct the class once and apply each operation, collecting returns."""
    instance = instance_class(*trace.constructor)
    # LeetCode's operation/argument/output arrays are index-aligned: the
    # constructor occupies index zero and therefore contributes its `null`.
    returns: list[Any] = [None]
    for operation in trace.operations:
        method = getattr(instance, operation.method, None)
        if method is None:
            raise HarnessError(f"method {operation.method!r} not found on {trace.class_name}")
        returns.append(method(*operation.args))
    return returns


def _run_generator(entry: Any, input_value: Any) -> Any:
    """Derive a seeded RNG from the integer seed input and call the generator."""
    if not isinstance(input_value, int) or isinstance(input_value, bool):
        raise HarnessError("generator input must be an integer seed")
    rng = random.Random(input_value)
    return entry(rng)


def _capture(thunk: Any) -> RunOutcome:
    """Run ``thunk``; a raised exception becomes an exception outcome, not a crash.

    A :class:`HarnessError` is a harness fault and propagates unchanged.
    """
    try:
        return RunOutcome(False, thunk())
    except HarnessError:
        raise
    except BaseException as err:  # noqa: BLE001 - target exceptions are a normal response
        return RunOutcome(True, err)
