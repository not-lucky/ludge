"""Problem-adapter native types: ``ListNode`` and ``TreeNode``.

These mirror the ``ListNode``/``TreeNode`` adapter tags of the canonical value
model. The canonical wire form stores a linked list as an ordered ``values``
array plus a nullable ``cycleIndex``, and a binary tree as a level-order
``values`` array (with ``null`` for absent children, trailing nulls stripped).
This module reconstructs native node graphs from those arrays and traverses them
back, with cycle detection on the linked-list side.

The classes are intentionally the familiar LeetCode-style shapes so target
solutions can consume and produce them directly.
"""

from __future__ import annotations

from collections import deque
from typing import Any


class ListNode:
    """A singly linked list node (``val`` payload, ``next`` link)."""

    __slots__ = ("val", "next")

    def __init__(self, val: Any = None, next: "ListNode | None" = None) -> None:
        self.val = val
        self.next = next


class TreeNode:
    """A binary tree node (``val`` payload, ``left``/``right`` children)."""

    __slots__ = ("val", "left", "right")

    def __init__(
        self,
        val: Any = None,
        left: "TreeNode | None" = None,
        right: "TreeNode | None" = None,
    ) -> None:
        self.val = val
        self.left = left
        self.right = right


def build_list(values: list[Any], cycle_index: int | None) -> ListNode | None:
    """Build a linked list from ordered payloads and an optional cycle index.

    :param values: The node payloads, head first.
    :param cycle_index: If not ``None``, the index within ``values`` that the
        tail's ``next`` links back to, forming a cycle.
    :returns: The head node, or ``None`` for an empty list.
    """
    if not values:
        return None
    nodes = [ListNode(val) for val in values]
    for i in range(len(nodes) - 1):
        nodes[i].next = nodes[i + 1]
    if cycle_index is not None:
        nodes[-1].next = nodes[cycle_index]
    return nodes[0]


def list_to_canonical(head: ListNode | None) -> tuple[list[Any], int | None]:
    """Traverse a linked list into ordered payloads plus a cycle index.

    Detects a cycle by identity: the first node revisited fixes ``cycleIndex``.

    :param head: The list head, or ``None``.
    :returns: ``(values, cycle_index)`` where ``cycle_index`` is ``None`` for an
        acyclic list.
    """
    values: list[Any] = []
    seen: dict[int, int] = {}
    node = head
    while node is not None:
        node_id = id(node)
        if node_id in seen:
            return values, seen[node_id]
        seen[node_id] = len(values)
        values.append(node.val)
        node = node.next
    return values, None


def build_tree(slots: list[Any]) -> TreeNode | None:
    """Build a binary tree from a level-order slot list.

    ``None`` entries denote absent children. Consumes the slots breadth-first,
    attaching the next two available slots as the left/right children of each
    real node, matching the canonical level-order layout.

    :param slots: Level-order values with ``None`` for gaps.
    :returns: The root node, or ``None`` for an empty tree.
    """
    if not slots or slots[0] is None:
        return None
    root = TreeNode(slots[0])
    queue: deque[TreeNode] = deque([root])
    index = 1
    while queue and index < len(slots):
        parent = queue.popleft()
        if index < len(slots):
            left = slots[index]
            index += 1
            if left is not None:
                parent.left = TreeNode(left)
                queue.append(parent.left)
        if index < len(slots):
            right = slots[index]
            index += 1
            if right is not None:
                parent.right = TreeNode(right)
                queue.append(parent.right)
    return root


def tree_to_canonical(root: TreeNode | None) -> list[Any]:
    """Traverse a binary tree into a level-order slot list.

    Emits ``None`` for absent children and strips trailing ``None`` slots so the
    result is the canonical, minimal level-order form.

    :param root: The tree root, or ``None``.
    :returns: The level-order slots with trailing nulls removed.
    """
    if root is None:
        return []
    slots: list[Any] = []
    queue: deque[TreeNode | None] = deque([root])
    while queue:
        node = queue.popleft()
        if node is None:
            slots.append(None)
            continue
        slots.append(node.val)
        queue.append(node.left)
        queue.append(node.right)
    while slots and slots[-1] is None:
        slots.pop()
    return slots
