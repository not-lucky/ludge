"""Reverse a Palestra-provided LeetCode-style singly linked list."""

from adapters import ListNode


def solution(head: ListNode | None) -> ListNode | None:
    previous = None
    current = head
    while current is not None:
        following = current.next
        current.next = previous
        previous = current
        current = following
    return previous
