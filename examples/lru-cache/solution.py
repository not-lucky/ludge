"""Stateful LRU Cache. Palestra constructs this class from LeetCode operations and arguments."""

from collections import OrderedDict


class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.values = OrderedDict()

    def get(self, key):
        if key not in self.values:
            return -1
        self.values.move_to_end(key)
        return self.values[key]

    def put(self, key, value):
        if key in self.values:
            self.values.move_to_end(key)
        self.values[key] = value
        if len(self.values) > self.capacity:
            self.values.popitem(last=False)
        return None
