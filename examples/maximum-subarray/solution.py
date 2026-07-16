"""Kadane's algorithm — the correct optimized implementation."""


def solution(nums):
    best_ending_here = nums[0]
    best = nums[0]
    for value in nums[1:]:
        best_ending_here = max(value, best_ending_here + value)
        best = max(best, best_ending_here)
    return best
