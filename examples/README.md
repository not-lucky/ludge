# Working examples

Each directory is a complete problem: a flat `problem.yaml`, required `problem.md`, a Python
`solution.py`, and plain LeetCode JSON cases. `maximum-subarray` also includes a
generator and naive oracle for stress testing.

From the repository root, copy one example into a workspace and run the built
CLI:

```bash
mkdir -p /tmp/palestra-work/problems
cp -R examples/two-sum /tmp/palestra-work/problems/
cd /tmp/palestra-work
node /path/to/palestra/dist/cli/main.js test two-sum --unsafe-local --json
```

Use `--unsafe-local` for local exploration when no delegated cgroup-v2 subtree
is available. A normal run uses the fixed cgroup/prlimit sandbox policy.

Available examples:

- `two-sum` — fixed cases and an alternative implementation for benchmarks.
- `maximum-subarray` — fixed cases, generator, naive oracle, and buggy solution.
- `course-schedule` — graph cycle detection with three fixed cases.
- `invert-binary-tree`, `reverse-linked-list`, `lru-cache` — tree, linked-list,
  and stateful-class examples using standard LeetCode JSON.
