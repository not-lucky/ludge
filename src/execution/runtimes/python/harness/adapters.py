"""Public problem-adapter types for target solutions.

Target solutions import :class:`ListNode` and :class:`TreeNode` from this module
to consume and produce linked lists and binary trees. The implementations live in
:mod:`canonical.adapters` so the codec and the public surface share one
definition; this module simply re-exports them under a stable, solution-facing
name.
"""

from __future__ import annotations

from canonical.adapters import ListNode, TreeNode

__all__ = ["ListNode", "TreeNode"]
