"""Deterministic generator. Palestra supplies the seeded `random.Random`."""


def solution(rng):
    # The positive prefix guarantees that the intentionally buggy candidate
    # differs from the oracle while the rest gives shrinking useful structure.
    # Function inputs are always positional argument arrays. The harness maps a
    # Python tuple to those positional arguments, so this one-argument problem
    # returns a one-item tuple rather than the raw list argument.
    return ([1, 2] + [rng.randint(-20, 20) for _ in range(rng.randint(0, 22))],)
