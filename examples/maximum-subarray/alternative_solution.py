"""A second correct implementation, useful as a readable comparison target."""


def solution(nums):
    current = 0
    answer = nums[0]
    for value in nums:
        current = max(value, current + value)
        answer = max(answer, current)
    return answer
