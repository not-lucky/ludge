"""LRU cache fixture for ClassTrace harness tests.

A minimal, dependency-free LRU cache with the classic ``get``/``put`` interface.
``get`` returns ``-1`` on a miss; ``put`` evicts the least-recently-used entry
when the capacity is exceeded and returns ``None``.
"""

from collections import OrderedDict


class LRUCache:
    """A fixed-capacity least-recently-used cache."""

    def __init__(self, capacity):
        self.capacity = capacity
        self._store = OrderedDict()

    def get(self, key):
        if key not in self._store:
            return -1
        self._store.move_to_end(key)
        return self._store[key]

    def put(self, key, value):
        if key in self._store:
            self._store.move_to_end(key)
        self._store[key] = value
        if len(self._store) > self.capacity:
            self._store.popitem(last=False)
        return None
