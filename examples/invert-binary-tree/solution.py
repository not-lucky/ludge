"""Invert a Palestra-provided LeetCode-style binary tree in place."""

from adapters import TreeNode


def solution(root: TreeNode | None) -> TreeNode | None:
    if root is None:
        return None
    root.left, root.right = solution(root.right), solution(root.left)
    return root
