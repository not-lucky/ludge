"""Identity solution fixture: returns its single argument unchanged."""


def solve(value):
    """Return ``value`` unchanged (round-trip identity for the harness tests)."""
    return value
