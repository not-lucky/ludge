"""Course Schedule — Kahn's topological-sort implementation."""


def solution(num_courses, prerequisites):
    graph = [[] for _ in range(num_courses)]
    indegree = [0] * num_courses
    for course, prerequisite in prerequisites:
        graph[prerequisite].append(course)
        indegree[course] += 1

    ready = [course for course, degree in enumerate(indegree) if degree == 0]
    completed = 0
    while ready:
        course = ready.pop()
        completed += 1
        for next_course in graph[course]:
            indegree[next_course] -= 1
            if indegree[next_course] == 0:
                ready.append(next_course)
    return completed == num_courses
