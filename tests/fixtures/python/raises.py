"""Fixture whose entry always raises, exercising the exception response path.

The harness must render a target-raised exception as a canonical ``exception``
value in a normal response line (not as a harness protocol error).
"""


def solve(_value):
    """Raise unconditionally so the harness captures a target exception."""
    raise ValueError("boom")
