# Palestra Judge

**Palestra** is a local, extensible judge for LeetCode-style programming problems. It runs Python solutions through `uv`, evaluates strict plain-JSON test cases, persists results in SQLite, and—on a suitably configured Linux host—runs target code inside a fail-closed cgroup-based sandbox.

It is designed for the full practice loop, not only a one-off test command:

| Capability                       | What it does                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed-case judging               | Runs every fixed case (or one selected case) against a solution.                                                                        |
| Stateful and structural problems | Supports ordinary functions, stateful LeetCode classes, linked lists, and binary trees.                                                 |
| Differential stress testing      | Generates deterministic inputs, compares a naive oracle with an optimized candidate, shrinks findings, and writes replayable artifacts. |
| Watch mode                       | Re-runs the current solution after stable file changes; newer edits cancel stale runs.                                                  |
| Benchmarking                     | Validates at least two correct solutions, then gathers paired isolated samples.                                                         |
| History and replay               | Stores runs in SQLite, reports history, and replays content-addressed fuzz artifacts.                                                   |

The [`examples/`](examples/README.md) directory contains six runnable problem bundles: functions, stateful classes, linked lists, trees, directed graphs, and an intentionally failing fuzz target.

> **Trust boundary:** challenge solutions, generators, references, test inputs, and problem assets are untrusted. Linux with delegated cgroup v2 control is the supported enforcement platform. Palestra is a local developer tool, **not** a kernel-grade multi-tenant isolation service.

## Contents

- [Requirements and installation](#requirements-and-installation)
- [Linux sandbox setup](#linux-sandbox-setup)
- [First run](#first-run)
- [Problem layout and configuration](#problem-layout-and-configuration)
- [Cases, Python callables, and adapters](#cases-python-callables-and-adapters)
- [Commands](#commands)
- [Results, artifacts, and exit codes](#results-artifacts-and-exit-codes)
- [Examples](#examples)
- [Safety and platform behavior](#safety-and-platform-behavior)
- [Detailed documentation](#detailed-documentation)

## Requirements and installation

Install and run Palestra from a repository checkout for now.

### Software requirements

- **Node.js 22 or later.** Palestra uses Node's built-in SQLite API; current Node 22+ is required by `package.json`.
- **Python 3** and the real [`uv`](https://docs.astral.sh/uv/) executable. Python target files are launched as `uv run --no-project --python <python> ...`.
- **Linux with cgroup v2 delegation** for normal, enforced verdicts. See [Linux sandbox setup](#linux-sandbox-setup).
- A POSIX-like shell for the setup examples below.

Clone, install, and build:

```bash
git clone <YOUR-PALESTRA-REPOSITORY-URL> palestra
cd palestra
npm ci
npm run build
```

Choose either invocation style once you have created or copied a problem into an invocation workspace:

```bash
# Make `palestra` available on your PATH from this checkout.
npm link

# Or avoid a global link and invoke the built CLI directly from any workspace.
node /path/to/palestra/dist/cli/main.js test two-sum --json
```

Use the [command reference](#commands) below for the exact schema-v1 grammar.

During development, rebuild after changing TypeScript or shipped Python harness files:

```bash
npm run build
```

## Linux sandbox setup

Palestra works with no path setup for ordinary local runs. It discovers `uv` and
`python3` from `PATH`, then keeps its cache and temporary runs inside the
invocation project's `.palestra/` directory:

```text
.palestra/uv-cache/
.palestra/tmp/
```

The only sandbox-specific host setting is the delegated cgroup v2 parent:

```bash
# Bash / Zsh (~/.bashrc, ~/.zshrc)
export PALESTRA_CGROUP_PARENT="/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"

# Fish (~/.config/fish/config.fish)
set -gx PALESTRA_CGROUP_PARENT "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"
```

`uv` and `python3` are always discovered from `PATH`; use your shell, virtual
environment, or CI image to choose them. Palestra deliberately does not expose
per-command runtime, codec, cache, or resource-policy switches.

### cgroup v2 delegation

`PALESTRA_CGROUP_PARENT` must be an **absolute writable cgroup-v2 directory**. It is not a normal directory under `$HOME` or `/tmp`. For each execution Palestra creates a child cgroup and writes kernel control files such as `memory.max`, `pids.max`, and `cgroup.procs`; those files exist only on a cgroup-v2 mount.

#### Verify the host before configuring Palestra

Run these commands in the same shell that will invoke Palestra:

- **Bash / Zsh**:

  ```bash
  # 1. Confirm that cgroup v2 is mounted and visible.
  stat -fc %T /sys/fs/cgroup       # expected: cgroup2fs
  cat /proc/self/cgroup            # expected to include a `0::/...` v2 entry

  # 2. Select the candidate delegated parent and inspect it.
  export PALESTRA_CGROUP_PARENT=/path/to/delegated/cgroup
  ls "$PALESTRA_CGROUP_PARENT"/cgroup.controllers \
     "$PALESTRA_CGROUP_PARENT"/cgroup.subtree_control \
     "$PALESTRA_CGROUP_PARENT"/cgroup.procs

  # 3. Verify that this user can create and remove a child cgroup.
  probe="$PALESTRA_CGROUP_PARENT/palestra-probe-$$"
  mkdir "$probe"
  rmdir "$probe"
  ```

- **Fish**:

  ```fish
  # 1. Confirm that cgroup v2 is mounted and visible.
  stat -fc %T /sys/fs/cgroup       # expected: cgroup2fs
  cat /proc/self/cgroup            # expected to include a `0::/...` v2 entry

  # 2. Select the candidate delegated parent and inspect it.
  set -gx PALESTRA_CGROUP_PARENT /path/to/delegated/cgroup
  ls "$PALESTRA_CGROUP_PARENT"/cgroup.controllers \
     "$PALESTRA_CGROUP_PARENT"/cgroup.subtree_control \
     "$PALESTRA_CGROUP_PARENT"/cgroup.procs

  # 3. Verify that this user can create and remove a child cgroup.
  set probe "$PALESTRA_CGROUP_PARENT/palestra-probe-%self"
  mkdir "$probe"
  rmdir "$probe"
  ```

All three steps must succeed. A failure such as `Permission denied` reading
`/sys/fs/cgroup`, missing `cgroup.controllers`, or `mkdir` failing means the
process has not been delegated a usable boundary. In particular, this is **not**
a fix:

- **Bash / Zsh**:

  ```bash
  # Wrong: an ordinary directory has no cgroup controllers.
  PALESTRA_CGROUP_PARENT="$HOME/stuff/palestra/tmp" palestra test two-sum
  ```

- **Fish**:

  ```fish
  # Wrong: an ordinary directory has no cgroup controllers.
  env PALESTRA_CGROUP_PARENT="$HOME/stuff/palestra/tmp" palestra test two-sum
  ```

That setup correctly fails with an error mentioning the missing
`cgroup.controllers` file.

#### Configure a delegated boundary (systemd user slice)

On a typical systemd Linux desktop or server, the recommended setup is a
persistent **user slice** with a delegated sandbox child. This lets you run
`palestra test` directly from any terminal without manual `systemd-run`
wrappers—Palestra handles the cgroup placement transparently (see
[automatic cgroup re-exec](#automatic-cgroup-re-exec) below).

**One-time setup** (run once, persists across reboots):

- **Bash / Zsh**:

  ```bash
  # 1. Create a systemd user slice with delegation.
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/palestra.slice << 'EOF'
  [Unit]
  Description=Palestra Judge Sandbox Slice

  [Slice]
  Delegate=yes
  MemoryAccounting=yes
  TasksAccounting=yes
  EOF
  systemctl --user daemon-reload
  systemctl --user start palestra.slice

  # 2. Create the sandbox cgroup and enable controllers.
  #    Replace user-1000 / user@1000 with your actual UID if different.
  SLICE_CG="/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice"
  mkdir -p "$SLICE_CG/sandbox"
  echo "+memory +pids +cpu" > "$SLICE_CG/cgroup.subtree_control"
  echo "+memory +pids +cpu" > "$SLICE_CG/sandbox/cgroup.subtree_control"

  # 3. Verify the sandbox directory passes the three checks above.
  ls "$SLICE_CG/sandbox"/cgroup.controllers   # should list: cpu memory pids
  probe="$SLICE_CG/sandbox/palestra-probe-$$"
  mkdir "$probe" && rmdir "$probe" && echo "OK"
  ```

- **Fish**:

  ```fish
  # 1. Create a systemd user slice with delegation.
  mkdir -p ~/.config/systemd/user
  echo '[Unit]
  Description=Palestra Judge Sandbox Slice

  [Slice]
  Delegate=yes
  MemoryAccounting=yes
  TasksAccounting=yes' > ~/.config/systemd/user/palestra.slice
  systemctl --user daemon-reload
  systemctl --user start palestra.slice

  # 2. Create the sandbox cgroup and enable controllers.
  #    Replace user-1000 / user@1000 with your actual UID if different.
  set SLICE_CG "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice"
  mkdir -p "$SLICE_CG/sandbox"
  echo "+memory +pids +cpu" > "$SLICE_CG/cgroup.subtree_control"
  echo "+memory +pids +cpu" > "$SLICE_CG/sandbox/cgroup.subtree_control"

  # 3. Verify the sandbox directory passes the three checks above.
  ls "$SLICE_CG/sandbox"/cgroup.controllers   # should list: cpu memory pids
  set probe "$SLICE_CG/sandbox/palestra-probe-%self"
  mkdir "$probe"; and rmdir "$probe"; and echo "OK"
  ```

**Shell profile configuration**:

Add `PALESTRA_CGROUP_PARENT` to your shell profile (replace `1000` with your actual UID if different):

- **Bash** (`~/.bashrc`):

  ```bash
  export PALESTRA_CGROUP_PARENT="/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"
  ```

- **Zsh** (`~/.zshrc`):

  ```zsh
  export PALESTRA_CGROUP_PARENT="/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"
  ```

- **Fish** (`~/.config/fish/config.fish`):
  ```fish
  set -gx PALESTRA_CGROUP_PARENT "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"
  ```

Then run normally from any terminal:

```bash
palestra test two-sum --json
```

For CI or containers, the image/runtime must mount cgroup v2 and delegate a
writable subtree into the container. `--privileged` alone is not a portable
substitute; validate the actual control files and child-directory creation.

Do **not** broadly `chmod` `/sys/fs/cgroup`, point the variable at an ordinary
directory, or run untrusted submissions as root merely to bypass this setup.

#### Automatic cgroup re-exec

On a systemd Linux host, your login shell typically runs in a session scope
(e.g. `session-2.scope`) that is in a different cgroup branch from the
`palestra.slice` where the sandbox lives. The Linux kernel does not allow
unprivileged PID migration across branches, so Palestra would fail with
`EACCES` when trying to place a target process into its sandbox cgroup.

Palestra detects this situation automatically: when the CLI starts a sandbox
command (`test`, `stress-test`, `watch`, `benchmark`, `replay`) and the current
process is not already inside the cgroup subtree that contains
`PALESTRA_CGROUP_PARENT`, it transparently re-execs itself via
`systemd-run --user --scope --slice=<slice>` to place the process in the
correct branch. A sentinel environment variable (`__PALESTRA_REEXEC`) prevents
infinite recursion; the re-exec is invisible to the caller and preserves the
original exit code.

This means you never need to manually wrap `palestra` in `systemd-run`.

The Linux runner has one fixed policy: cgroup v2 enforces memory and process
limits, `prlimit` supplies process-local ceilings for CPU time, address-space
size, file size, and open descriptors, and the supervisor owns timeout, bounded
output, and cleanup. If the boundary cannot be created, a normal run fails
closed as `spawn_error`; `--unsafe-local` is the explicit local development
escape hatch.

### Configuration variables

Palestra recognizes only `PALESTRA_CGROUP_PARENT` (delegated Linux cgroup root)
and, when necessary, `PALESTRA_STATE_DIR` (the project-local state directory).
They are host locations, never problem or limit overrides.

- **Bash** (`~/.bashrc`):

  ```bash
  export PALESTRA_CGROUP_PARENT="/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"
  export PALESTRA_STATE_DIR="$HOME/.palestra-state"
  ```

- **Zsh** (`~/.zshrc`):

  ```zsh
  export PALESTRA_CGROUP_PARENT="/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"
  export PALESTRA_STATE_DIR="$HOME/.palestra-state"
  ```

- **Fish** (`~/.config/fish/config.fish`):
  ```fish
  set -gx PALESTRA_CGROUP_PARENT "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/palestra.slice/sandbox"
  set -gx PALESTRA_STATE_DIR "$HOME/.palestra-state"
  ```

## First run

Palestra treats the directory from which you invoke it as the project root. Problems live below `problems/<slug>/` there.

Create a starter problem:

```bash
mkdir -p ~/palestra-work
cd ~/palestra-work
palestra init scratch-sum
```

`init` creates `problems/scratch-sum/problem.yaml`, `problem.md`, a starter `solution.py`, and an empty `cases/` directory, then registers the problem in `.palestra/judge.sqlite`. Fill in the signature, statement, solution, and cases; or copy a ready-to-run example **instead of initializing that same slug first**:

```bash
# From the Palestra repository checkout, while ~/palestra-work is the workspace:
cp -R /path/to/palestra/examples/two-sum "$HOME/palestra-work/problems/"

cd "$HOME/palestra-work"
palestra test two-sum
```

If your host is not configured for full Linux enforcement, use the explicit local-development escape hatch:

```bash
palestra test two-sum --unsafe-local --json
```

That command never produces a trusted pass: its final status is always `sandbox_unsupported` with exit code `4`. It is not a general bypass for runtime or sandbox setup—required execution setup may still fail before a target starts—so use it only for local wiring/debugging, never as a correctness or security signal.

## Problem layout and configuration

A problem directory is self-contained:

```text
problems/two-sum/
├── problem.yaml
├── problem.md                 # required problem statement
├── solution.py
├── alternative_solution.py      # optional; useful for benchmarks
├── generator.py                 # optional; required by stress-test if no CLI override
├── naive.py                     # optional; required by stress-test if no CLI override
└── cases/
    ├── 01-basic.json
    └── 02-more-cases.json
```

`problem.yaml` is strict: unknown fields, duplicate YAML keys, invalid types, and root-escaping paths are rejected. Schema v1 fixes Python/uv, the internal tagged JSONL transport, and exact comparison. Case authors write ordinary JSON; the signature is the source of truth for interpreting it. A function problem requires:

```yaml
schemaVersion: 1
slug: two-sum
title: Two Sum
entrypoint: solution.py
limits: {}
casesDir: cases
args: ["list[int]", int]
returns: list[int]

# Optional:
# generator: generator.py
# naive: naive.py
```

All problem-local paths are relative to the problem root and may not escape it. `--solution`, `--generator`, `--naive`, and selected-case paths are resolved from the invocation directory, so use a path such as `problems/two-sum/alternative_solution.py` when passing an override from the project root.

### Limits

Limits are product defaults with optional per-problem overrides in `problem.yaml`.
CLI flags choose feature inputs such as a solution or generator; they do not
silently rewrite resource policy.

The current built-in defaults applied by `limits: {}` are:

| Limit                         |    Default |
| ----------------------------- | ---------: |
| `wallTimeMs`                  |   2,000 ms |
| `cpuTimeMs`                   |   2,000 ms |
| `memoryBytes`                 |    256 MiB |
| `stdoutBytes` / `stderrBytes` | 1 MiB each |
| `combinedOutputBytes`         |      2 MiB |
| `inputBytes`                  |      4 MiB |
| `fileSizeBytes`               |      8 MiB |
| `processCount`                |         64 |
| `openDescriptors`             |        256 |
| `tempStorageBytes`            |     64 MiB |
| `concurrencyPerCase`          |          1 |

Override only the values appropriate for the problem:

```yaml
limits:
  wallTimeMs: 1000
  memoryBytes: 134217728
```

## Cases, Python callables, and adapters

A fixed-case file is a UTF-8 `.json` document in ordinary LeetCode JSON, never a tagged protocol value or request/response envelope. Function `input` is _always_ the positional-argument array, including for a one-argument function.

For backwards compatibility, a file may contain one case with **exactly** `input` and `expected`:

```json
{
  "input": [[2, 7, 11, 15], 9],
  "expected": [0, 1]
}
```

Prefer grouping related logical cases in one file. A grouped file has **exactly** one `cases` key whose value is a non-empty array; every member must itself have exactly `input` and `expected`:

```json
{
  "cases": [
    { "input": [[2, 7, 11, 15], 9], "expected": [0, 1] },
    { "input": [[3, 2, 4], 6], "expected": [1, 2] }
  ]
}
```

Files run in lexical filename order and grouped members run in array order. Results identify every logical member (including a legacy one-case file) with a stable zero-based suffix such as `cases/basic.json#0`. Empty arrays, extra wrapper/member keys, duplicate JSON keys, non-JSON files, and symlinked case assets are rejected. `--case <path>` selects one case **file**, so it runs all members in that selected group.

The signature drives every conversion before JSON values are interpreted. Thus `"123"` under an `int` signature means integer 123, while it remains text under `str`. The supported type grammar is `int`, `float`, `str`, `bool`, `null`, `list[T]`, `ListNode`, and `TreeNode` (nodes default to integer values; `ListNode[T]` and `TreeNode[T]` are also available). The default function symbol is `solution`.

### Structural adapters

The shipped harness exposes familiar LeetCode node classes to solution code:

```python
from adapters import ListNode, TreeNode
```

- `ListNode` values use flat arrays, e.g. `[1, 2, 3]`; an empty array is a null head.
- `TreeNode` values use LeetCode level order, e.g. `[1, 2, 3, null, 4]`; trailing nulls are optional.
- Stateful classes declare their constructor and methods in `problem.yaml`:
  ```yaml
  class: LRUCache
  constructor: [int]
  methods:
    put:
      args: [int, int]
      returns: null
    get:
      args: [int]
      returns: int
  ```
  Their input is `[operations, arguments]` and expected output is a same-length array. The first operation is the class name, its expected result is `null`, and every void operation also has `null`, exactly as LeetCode does.
- Graphs have no special node adapter. Represent graph data with nested lists, e.g. `list[list[int]]` for prerequisites.

## Commands

`--unsafe-local` may appear before or after a command. It is accepted only by `test`, `stress-test`, `watch`, `benchmark`, and `replay`.

### Initialize

```text
palestra init <slug> [--json]
```

Creates and registers a complete starter problem (`problem.yaml`, `problem.md`, `solution.py`, and `cases/`). Slugs are lowercase kebab-case; existing slugs are rejected.

### Run fixed cases

```text
palestra test <slug> [--solution <path>] [--case <path>] [--jobs <n>] [--json] [--unsafe-local]
```

Run all top-level `cases/*.json` files in lexical order. Related cases can be grouped in one file and execute concurrently; Palestra uses a bounded automatic worker count unless `--jobs <n>` is supplied:

```bash
palestra test two-sum
```

Run one case file/group by name (falls back to `cases/<name>` if the path does not exist from the invocation directory):

```bash
palestra test two-sum --case 02-later-pair.json
```

Test an explicit candidate without modifying `problem.yaml`:

```bash
palestra test two-sum --solution problems/two-sum/alternative_solution.py
```

### Differential stress test

```text
palestra stress-test <slug> [--generator <path>] [--naive <path>] [--solution <path>]
  [--seed <uint64>] [--cases <n>] [--duration <ms>] [--jobs <n>]
  [--shrink] [--json] [--unsafe-local]
```

Palestra calls the generator with a deterministic `random.Random` derived from the seed, runs the naive implementation first, then runs the candidate with the identical encoded input. Defaults are 10,000 cases, 60,000 ms, and one job. The first actionable mismatch or runtime failure stops the run; naive failure is reported separately as `oracle_failure`.

A repeatable failure demonstration is in [`examples/maximum-subarray`](examples/maximum-subarray):

```bash
palestra stress-test maximum-subarray \
  --solution problems/maximum-subarray/buggy_solution.py \
  --seed 20250308 --cases 20 --duration 10000 --shrink --json
# Expected on a fully configured Linux host: wrong_answer, exit 1, and an artifactId.
```

The generator deliberately begins with a positive pair, so the included `buggy_solution.py` (which returns only the maximum element) mismatches the correct oracle. Do not use that candidate for ordinary `test` or `benchmark` commands.

### Watch a solution

```text
palestra watch <slug> [--solution <path>] [--debounce <ms>] [--jobs <n>] [--json] [--unsafe-local]
```

For example:

```bash
palestra watch two-sum --solution problems/two-sum/solution.py --debounce 150
```

Watch rescans rather than trusting filesystem events alone. A new file generation cancels stale work; press `Ctrl-C` to stop it cleanly (exit `130`). In JSON mode, the final command outcome remains a single stdout envelope; live watch facts are JSON Lines on stderr.

### Benchmark correct alternatives

```text
palestra benchmark <slug> --solutions <path[,path...]> [--cases <path>]
  [--warmup <n>] [--samples <n>] [--json] [--unsafe-local]
```

At least two comma-separated, distinct paths are mandatory. Every candidate must first match expected output on every selected fixed case. Defaults are 3 warmups and 30 measured samples per solution/case. Each sample is isolated; measurements include launch, sandbox setup, Python/`uv` startup/import, execution, and output collection. Palestra records CPU-control/environment metadata and labels a run `non_comparable` when comparable CPU controls were unavailable.

```bash
palestra benchmark two-sum \
  --solutions solution.py,alternative_solution.py \
  --warmup 1 --samples 5 --json
```

For `benchmark`, solution paths are resolved within the selected problem root; the example above intentionally uses problem-relative filenames.

### Report persisted history

```text
palestra report [<slug>] [--since <YYYY-MM-DD>] [--json]
```

```bash
palestra report maximum-subarray --since 2025-01-01 --json
```

`report` is read-only. An empty successful query is still exit `0`.

### Replay a fuzz artifact

```text
palestra replay <artifact-id> [--json] [--unsafe-local]
```

Copy the `artifactId` from the stress-test JSON result or artifact directory name:

```bash
palestra replay <64-hex-artifact-id> --json
```

Replay verifies the artifact's SHA-256 content ID, restores its recorded input and policies, reruns the oracle and candidate, and persists a new replay run linked to the original artifact.

## Results, artifacts, and exit codes

By default human-readable result data goes to stdout and diagnostics go to stderr. `--json` emits **exactly one** schema-v1 JSON envelope on stdout with the command, correlation ID, status, exit code, result, and diagnostics. It emits no human text.

|  Exit | Meaning                                                                                                         |
| ----: | --------------------------------------------------------------------------------------------------------------- |
|   `0` | Passed / no differential mismatch.                                                                              |
|   `1` | Wrong answer or differential mismatch.                                                                          |
|   `2` | Target runtime failure: nonzero exit, signal, timeout, memory/output/file/process violation, or protocol error. |
|   `3` | Invalid CLI input, configuration, or problem data.                                                              |
|   `4` | Sandbox unsupported/setup failure, including every `--unsafe-local` result.                                     |
|   `5` | CLI/internal failure.                                                                                           |
| `130` | User cancellation.                                                                                              |

Palestra creates local state under the invocation root:

```text
.palestra/
├── judge.sqlite                         # runs, cases, executions, benchmarks, reports
└── artifacts/<sha256>/artifact.json     # immutable replayable differential findings
```

`test` and `stress-test` persist runs/cases/executions; a stress mismatch also persists its artifact. `watch` persists only current-generation results. `benchmark` persists samples and aggregates. `replay` writes a new run linked to the artifact. Artifact retention is manual deletion; Palestra never silently evicts old artifacts.

## Examples

All bundles are committed under [`examples/`](examples/README.md). Copy the whole directory—not only `solution.py`—into your invocation root's `problems/` directory:

```bash
mkdir -p problems
cp -R /path/to/palestra/examples/reverse-linked-list problems/
palestra test reverse-linked-list
```

| Bundle                                                | Shape and feature demonstrated                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`two-sum`](examples/two-sum)                         | Top-level tuple → positional Python parameters; fixed cases, selected case, watch, and two correct implementations for benchmarking.                       |
| [`lru-cache`](examples/lru-cache)                     | Stateful LeetCode operations/arguments → `LRUCache` construction and method calls.                                                                         |
| [`reverse-linked-list`](examples/reverse-linked-list) | `ListNode` decoding/encoding and mutation-safe linked-list output.                                                                                         |
| [`invert-binary-tree`](examples/invert-binary-tree)   | `TreeNode` level-order decoding/encoding.                                                                                                                  |
| [`course-schedule`](examples/course-schedule)         | Directed graph traversal with nested lists.                                                                                                                |
| [`maximum-subarray`](examples/maximum-subarray)       | Fixed cases, correct optimized/alternative solutions, naive oracle, deterministic generator, intentional mismatch, shrink, artifact replay, and reporting. |

The [example guide](examples/README.md) has exact copy commands and the complete walkthrough, including the command expected to exit `1`.

## Safety and platform behavior

- **Full Linux enforcement:** required controls are probed before target execution and fail closed. A successful verdict is impossible when a required control cannot be installed.
- **`--unsafe-local`:** explicitly opts out of enforced execution for supported run commands. Palestra labels the final outcome `sandbox_unsupported` and exits `4` even if the candidate would otherwise pass. Do not treat it as a secure run.
- **macOS and Windows:** are not normal enforcement platforms. Use a Linux VM/container with correctly delegated cgroup v2 controls for trusted verdicts.
- **Untrusted code:** never assume a local sandbox makes arbitrary code safe for hostile multi-tenant use. Keep secrets and unrelated files away from the development machine/container that runs submissions.
- **No shell command interpolation:** Palestra launches `uv` and Python as executable-plus-argument arrays, gives targets a sanitized environment, and bounds request/output handling. These are defense-in-depth properties, not a substitute for operating-system isolation policy.

## Development

For contributors, project checks are:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```
