# Palestra architecture audit and minimal-refactor plan

## Context

Audit the current TypeScript source tree for evidence-supported simplification while preserving the local judge’s CLI behavior, persistence integrity, and execution sandbox safety. The current dirty worktree—including its substantial architectural consolidation and deletions—is the explicitly approved audit baseline. Its pre-existing changes remain user-owned; this plan proposes subsequent changes only.

Initial discovery:

- Node ESM CLI package (`palestra` → `dist/cli/main.js`), requiring Node `>=22`. The package is explicitly CLI-only: `dist/*` deep imports are not supported APIs. The CLI binary and its documented invocation are the observable public boundary; internal source exports may be removed when unused.
- Build/type-check: `tsc`; tests: Vitest; lint: ESLint plus dependency-cruiser.
- `src/` is the compilation and metric scope; tests, examples, generated `dist/`, and declaration/build output are excluded.
- No runtime npm dependencies; seven development dependencies.
- No `*.d.ts`, `*.generated.ts`, `generated/`, or `vendor/` paths under `src/` were found.

## Baseline and projected metrics

| Metric | Baseline | Projected | Actual After Refactor | Notes |
|---|---:|---:|---:|---|
| TypeScript code lines | 14,551 | 14,500–14,550 | 14,539 | `tokei -t TypeScript ./src/`; source only |
| TypeScript comment lines | 3,693 | 3,550–3,650 | 3,672 | Source only |
| TypeScript blank lines | 1,093 | 1,050–1,090 | 1,084 | Source only |
| `.ts` / `.tsx` files | 101 / 0 | 99 / 0 | 99 / 0 | Source only |
| Test `.ts` / `.tsx` files | 50 / 0 | 48 / 0 | 48 / 0 | Excluded from source baseline |
| Maximum source depth | 6 | 6 | 6 | Preserve SQLite repository grouping |
| Runtime dependencies | 0 | 0 | 0 | npm |
| Development dependencies | 7 | 7 | 7 | npm |
| Barrel files | 6 | 5 | 5 | Removed orphaned `src/judging/index.ts` |
| Source-orphan modules | 2 | 0 | 0 | No source orphans after deletion |
| One-implementation interfaces / abstract classes | 4 / 0 | 4 / 0 | N/A | Four implementation declarations are meaningful host/test boundaries; no abstract classes |
| Native-API replacement candidates | 0 justified | 0 | N/A | Node 22 APIs already used; local timers carry extra semantics |

The optimization percentage targets are not realistic or desirable for this baseline. The current dirty-tree refactor has already removed the large layered structure; further 15–30% executable-code deletion would require collapsing validated protocol parsing, sandbox enforcement, SQLite durability/recovery, or command behavior without evidence that those are redundant.

## Executive summary

The current dirty-tree refactor has already removed the largest prior complexity: legacy port/barrel/config/runtime layers are now mostly gone. The highest-confidence next reductions are two source-orphan modules, five zero-consumer type aliases, and two unused test fixtures. The most important corrective change is not a code-size reduction: three tests still resolve deleted source paths through stale ignored `dist/` output, making clean-source test verification incomplete.

Do not flatten the execution host seams or SQLite access layer. Their apparent one-implementation shape is justified by deterministic injection, host-specific watcher/sandbox semantics, reader-versus-writer separation, rollback/retry behavior, and explicit operational tests. The requested 15–30% executable reduction is neither realistic nor safe after the current architectural consolidation.

Top recommendations:

1. Repair stale test imports and remove their unused fixtures. This restores a trustworthy clean-build test signal without deleting coverage.
2. Delete the two proven source-orphan modules (`judging/index` and JSONL telemetry adapter). They have no internal consumers and no supported external API.
3. Simplify the stale dependency-cruiser policy and remove zero-consumer aliases, then leave validated sandbox, input-validation, and persistence boundaries intact.

Risks and assumptions: the package is CLI-only (confirmed); the ignored `dist/` directory is stale build output rather than a source asset; Node 22+ remains the deployment contract; behavior related to cgroups, SQLite durability/recovery, untrusted-input validation, telemetry containment/redaction, and cleanup is out of scope for deletion.

## Approach

1. Establish a clean evidence baseline from the current working tree, preserving and separately reporting pre-existing failures and uncommitted changes.
2. Trace entry points, package-public surface, module consumers, and dependency graph before recommending deletion, inlining, or moves.
3. Classify each potential simplification using the delete → native API → language → inline → consolidate ladder, retaining security, persistence, external-input validation, and operational behavior where justified.
4. Produce an implementation-ready audit with an explicit directory comparison, a row for every evaluated affected module, concrete compilable diffs only for evidenced recommendations, dependency review, phased execution, and verification gates.

## Files to modify

Planned implementation scope (subject to review):

- Delete: `src/judging/index.ts`, `src/telemetry/adapters/jsonl-sink.ts`, and unused test helpers `tests/helpers/fake-clock.ts`, `tests/helpers/fake-sandbox.ts`.
- Update stale tests: `tests/contract/telemetry-ports.contract.test.ts`, `tests/unit/telemetry/publisher.test.ts`.
- Simplify aliases/types: `src/application/execute-case.ts`, `src/application/run-context.ts`, `src/cli/cancellation.ts`, `src/cli/command.ts`, `src/application/report-command.ts`.
- Reconcile current source boundaries: `.dependency-cruiser.cjs` and affected tests. Retain `src/persistence/sqlite/{store,transaction-scope,unit-of-work,repositories}/` because evidence supports its reader/writer and transaction-ownership boundary.
- `PLAN.md` only is modified during this planning phase.

## Reuse

Initial candidates requiring evidence before a recommendation:

- Existing dependency-boundary policy: `.dependency-cruiser.cjs`; its prose still describes deleted `ports` and adapter layout and must be reconciled with the actual current graph before relying on it as architecture evidence. The active rules passed against 111 cruised modules and 406 dependencies; follow-up graph analysis used the locally installed binary directly. Its stale path rules also leave deleted paths in current test imports (`execution/ports/index`, `telemetry/ports/index`), which pass only because ignored `dist/` still contains prior build output; these tests are not exercising current source paths.
- Existing Node 22 platform surface is already used where appropriate: `node:crypto.randomUUID` (`src/cli/context.ts`), `node:fs/promises`, `node:sqlite`, and process timers.
- Existing module-level boundaries: `src/domain/index.ts`, `src/judging/codec/index.ts`, `src/judging/comparator/index.ts`, `src/telemetry/index.ts`, and `src/watch/index.ts` have active source/test consumers and should be retained as intentional internal boundaries. `src/judging/index.ts` has no source or test consumer and is a high-confidence deletion candidate; its removal is authorized because the package is CLI-only.
- `src/telemetry/adapters/jsonl-sink.ts` has no source or test consumer and is a high-confidence deletion candidate; the CLI’s actual stderr JSONL emission is an inline `TelemetrySink`-compatible object in `src/cli/context.ts`.
- Preserve the actively used execution seam modules (`cancellation.ts`, `clock.ts`, `filesystem.ts`, `runner.ts`) and `NodeFileSystem`: their injection is used by application policy and deterministic tests, and filesystem watching/cancellation are operational boundaries.
- High-confidence compatibility-alias cleanup candidates: `SerializedCommand` and `CommandResult` in `src/cli/command.ts`, `IsolatedExecutionDependencies` in `src/application/execute-case.ts`, `CancellationTokenSource` in `src/cli/cancellation.ts`, and `RunCancellation` in `src/application/run-context.ts` have no consumers beyond their declarations. `IsolatedExecution` has three command-module consumers and remains a useful semantic result alias. `orderImplementations` has one intentional benchmark-policy consumer and needs a readability decision, not automatic removal.
- The 11 SQLite repository modules (493 lines) are used only by `SqliteStore`/`SqliteTransaction`, except the read-only run repository type leaking into `src/application/report-command.ts`. Do not flatten this yet: the split makes reader-versus-writer connection ownership and atomic transaction scope explicit. First replace that application dependency with a local structural `Pick` or dedicated minimal read type, then reassess colocation without weakening the query-only guard.
- No runtime dependency removal or native replacement is proposed: runtime dependencies are zero, Node 22 APIs already provide crypto/filesystem/SQLite functionality, and local delay functions preserve test injection or process-termination behavior.
- CLI composition is intentionally centralized in `src/cli/context.ts`: it constructs SQLite, filesystem, clocks, cancellation, process execution, and use-case dependencies. `src/cli/main.ts` owns signal/cleanup ordering. These are high-risk operational boundaries, not initial deletion candidates.

## Steps

- [x] Use the current dirty working tree, including its uncommitted architecture changes, as the audit baseline; preserve those changes as user-owned.
- [x] Inspect README, dependency-cruiser rules, entry-point composition, test layout, public exports, package lockfile, and repository history where useful. README and composition were reviewed; dependency-cruiser documentation/path rules are stale relative to current paths. The package has no declared library export surface and no in-repo package consumers; `dist/` is ignored build output and contains stale deleted modules, masking stale test imports that must be corrected before trusting clean-build verification.
- [x] Run baseline type-check, test, lint, and build commands; no pre-existing failures. Vitest: 45 files passed, 494 tests passed, 2 skipped; dependency-cruiser: 111 modules / 406 dependencies with no violations; build copied Python harness assets.
- [x] Calculate import/reference counts, identify single-use and re-export-only modules, and map interfaces/classes to implementations and construction sites. Import graph evidence: 111 source modules / 406 dependencies; only `src/judging/index.ts` and `src/telemetry/adapters/jsonl-sink.ts` are source orphans. Six `index.ts` barrels range from 18–60 lines; the other five have direct consumers. No abstract classes exist; four classes declare an interface implementation, each retained for evidenced host/test behavior.
- [x] Audit validation, error/recovery, sandbox, SQLite migration/durability, and telemetry paths as protected operational boundaries. Retain the execution seam modules even though their Node implementations are currently singular: their use by deterministic tests and host-specific watcher/sandbox behavior demonstrates a real boundary.
- [x] Identify source/test drift: three stale source imports resolve only through ignored stale `dist/`; two now-unused fixtures (`fake-clock`, `fake-sandbox`) have no consumers. Correct imports and delete fixtures in the safe-pruning batch; do not delete or dilute their behavioral tests.
- [x] Audit runtime dependencies and local utilities for native replacements, with semantic and Node 22 compatibility evidence. No runtime packages exist; `randomUUID` already comes from `node:crypto`. Retain delay/backoff helpers because they model cgroup kill grace, injectable watch scheduling, and injectable SQLite retry timing.
- [x] Confirm package boundary: Palestra is CLI-only and does not support `dist/*` deep imports; delete unused internal exports where evidence supports it.
- [x] Draft the requested executive summary, directory comparison, deletion/consolidation audit, concrete diffs, dependency plan, execution phases, and final verification checklist.
- [ ] Submit the completed plan for review.

## Proposed directory structure

```text
CURRENT:                                      PROPOSED:
src/                                          src/
├── judging/                                  ├── judging/
│   ├── index.ts                 DELETE       │   ├── codec/
│   ├── codec/                                │   ├── comparator/
│   └── comparator/                           │   ├── leetcode.ts
├── telemetry/                                │   └── value/
│   └── adapters/                             ├── telemetry/
│       └── jsonl-sink.ts        DELETE       │   ├── ports/
└── persistence/sqlite/                       │   └── render/
    └── repositories/            KEEP         └── persistence/sqlite/
                                                 └── repositories/  KEEP

tests/helpers/                               tests/helpers/
├── fake-clock.ts                DELETE       └── black-box.ts
├── fake-sandbox.ts              DELETE
└── black-box.ts
```

Ownership remains intentionally unchanged for active domains. The judging top-level barrel and JSONL adapter have no consumer; deleting them removes only dead ownership. The SQLite `repositories/` directory remains because it makes reader-versus-writer connection ownership and per-table transaction behavior explicit; its depth is purposeful rather than accidental.

## Deletion and consolidation audit

| Path | Action | Target | Evidence | Rationale | Risk |
|---|---|---|---|---|---|
| `src/judging/index.ts` | DELETE | N/A | 0 source/test consumers in dependency graph; CLI-only package | Dead top-level re-export barrel | Low |
| `src/telemetry/adapters/jsonl-sink.ts` | DELETE | N/A | 0 source/test consumers; CLI emits directly through local sink object | Dead one-class adapter | Low |
| `tests/helpers/fake-clock.ts` | DELETE | N/A | No imports outside declaration | Unused fixture | Low |
| `tests/helpers/fake-sandbox.ts` | DELETE | N/A | No imports outside declaration; it imports deleted source barrel | Unused, stale fixture | Low |
| `tests/contract/telemetry-ports.contract.test.ts` | SIMPLIFY | `src/telemetry/ports/sink.ts` | Imports deleted `telemetry/ports/index.ts`; test passes only from stale `dist` | Point type-only import at current source module; preserve contract assertions | Low |
| `tests/unit/telemetry/publisher.test.ts` | SIMPLIFY | `src/telemetry/ports/sink.ts` | Same stale import | Restore clean-source module resolution | Low |
| `src/application/execute-case.ts` | SIMPLIFY | N/A | `IsolatedExecutionDependencies` has no consumers | Delete redundant alias; retain `IsolatedExecution` semantic alias used by three commands | Low |
| `src/application/run-context.ts` | SIMPLIFY | N/A | `RunCancellation` has no consumers | Delete redundant alias | Low |
| `src/cli/cancellation.ts` | SIMPLIFY | N/A | `CancellationTokenSource` has no consumers | Delete compatibility re-export; retain source/token behavior | Low |
| `src/cli/command.ts` | SIMPLIFY | N/A | `SerializedCommand` and `CommandResult` have no consumers | Delete aliases; retain parser and handler types | Low |
| `src/domain/index.ts` | KEEP | N/A | 23 inbound source edges plus test consumers | Intentional pure-domain boundary | Low |
| `src/judging/codec/index.ts` | KEEP | N/A | 4 source consumers plus tests | Stable internal codec boundary | Low |
| `src/judging/comparator/index.ts` | KEEP | N/A | 4 source consumers plus tests | Stable internal comparison-policy boundary | Low |
| `src/telemetry/index.ts` | KEEP | N/A | CLI source consumer and tests | Cohesive telemetry boundary | Low |
| `src/watch/index.ts` | KEEP | N/A | Application and CLI consumers plus tests | Cohesive watch-policy boundary | Low |
| `src/execution/{cancellation,clock,filesystem,runner}.ts` | KEEP | N/A | Used across application policy and deterministic tests | Real testability/host boundary, not one-implementation DI | Medium |
| `src/infrastructure/filesystem/node-filesystem.ts` | KEEP | N/A | Node watcher semantics, ignored-path filtering, platform capabilities | Runtime adapter with nontrivial behavior | Medium |
| `src/persistence/sqlite/repositories/*.ts` | KEEP | N/A | 493 lines; instantiated only by store/UOW, but express reader/writer ownership and transaction scoping | Avoid a broad merge that obscures durable write boundaries; first remove application’s concrete repository type leak | Medium |
| `src/persistence/sqlite/{store,transaction-scope,unit-of-work,writer-queue}.ts` | KEEP | N/A | Own safe open, WAL/recovery, serialized writer, rollback, bounded retry | Security/operational persistence boundary | High |
| `src/execution/{cgroup,linux-sandbox,reaper,spawn}.ts` | KEEP | N/A | cgroup enforcement, process-tree cleanup, resource limits; protected tests | Sandbox safety boundary | High |
| `src/infrastructure/problem.ts`, `src/application/fixed-cases.ts`, `src/judging/codec/*` | KEEP | N/A | Parse/validate untrusted problem and case inputs | External-input validation boundary | High |

## Concrete refactoring diffs

### Repair telemetry test imports

Reason: both tests currently resolve a deleted source barrel through stale ignored build output. Import the actual type module directly; behavior and assertions are unchanged.

```typescript
// BEFORE: tests/unit/telemetry/publisher.test.ts
import type { TelemetrySink } from "../../../src/telemetry/ports/index.js";

// AFTER: tests/unit/telemetry/publisher.test.ts
import type { TelemetrySink } from "../../../src/telemetry/ports/sink.js";
```

Apply the equivalent change in `tests/contract/telemetry-ports.contract.test.ts`. Required verification: remove `dist/` in an isolated clean checkout or build directory, then run `npm test` to prove tests resolve current source rather than historical output.

### Remove an unused compatibility alias

Reason: `RunCancellation` has zero consumers; it does not encode a distinct invariant.

```typescript
// BEFORE: src/application/run-context.ts
import type { CancellationToken } from "../execution/cancellation.js";
// ...
/** A small adapter for application code that only needs a cancellation token. */
export type RunCancellation = CancellationToken;

// AFTER: src/application/run-context.ts
// Remove the unused CancellationToken import and RunCancellation alias.
```

Apply the same delete-only treatment to `IsolatedExecutionDependencies`, `CancellationTokenSource`, `SerializedCommand`, and `CommandResult`. Do not remove `IsolatedExecution`: command modules use it to name a completed isolated execution result.

### Remove the unused telemetry adapter

Reason: no code constructs `JsonlTelemetrySink`; `src/cli/context.ts` owns the actual stderr JSONL sink and deliberately lets `publishSafely` contain write failures.

```typescript
// DELETE: src/telemetry/adapters/jsonl-sink.ts
```

Do not replace it with another wrapper. Required verification: type-check, telemetry publisher tests, and the CLI black-box tests.

## Dependency removal plan

| Package | Current uses | Native replacement | Compatibility risk | Action |
|---|---|---|---|---|
| Runtime npm packages | 0 | N/A | None | Keep zero runtime dependencies |
| `@types/node` | Node API type checking | N/A | High if removed | Keep |
| `typescript` | Build/type-check/declarations | N/A | High if removed | Keep |
| `vitest` | 45 passing test files | N/A | High if removed | Keep |
| `eslint` + `typescript-eslint` | Configured lint check | N/A | Medium | Keep |
| `dependency-cruiser` | 111-module / 406-edge boundary check | N/A | Medium | Keep; update stale path policy rather than remove the guard |
| `prettier` | Configured formatting commands | N/A | Low-to-medium | Keep unless the team explicitly retires formatting automation; no evidence supports removal |

No replacement is proposed for local timers: reaper delay preserves SIGTERM grace before SIGKILL, watch delay is injected through the scheduler seam, and SQLite retry delay is injectable for deterministic tests. `node:crypto.randomUUID()` is already used for identifier generation.

## Execution plan

- [x] 1. **Eliminate stale-resolution risk.** Updated the two telemetry test imports to `ports/sink.js`; deleted `tests/helpers/fake-clock.ts` and `tests/helpers/fake-sandbox.ts`. With inherited `dist/` removed, type-check passed; source suites passed, and the expected compiled-CLI black-box failures identified the missing build prerequisite. After a fresh build, all tests passed (45 files; 494 passed, 2 skipped). Source impact: no executable-code reduction; two test files removed.
- [x] 2. **Prune proven dead source modules.** Deleted `src/judging/index.ts` and `src/telemetry/adapters/jsonl-sink.ts`; no source or test imports remain. Type-check passed; dependency-cruiser passed with 108 modules / 400 dependencies; focused telemetry, telemetry-contract, and CLI black-box suites passed (20 passed, 2 skipped). Actual impact: two source files removed.
- [x] 3. **Remove internal compatibility aliases.** Deleted zero-consumer aliases `IsolatedExecutionDependencies`, `RunCancellation`, `CancellationTokenSource`, `SerializedCommand`, and CLI `CommandResult` (similarly named command result interfaces remain). Type-check and the full suite passed: 45 files; 494 passed, 2 skipped.
- [x] 4. **Align architecture enforcement with the current tree.** Updated `.dependency-cruiser.cjs` documentation and replaced the deleted `judging/fuzzing` restrictions with active watch/benchmark sibling rules; retained circular, orphan, domain purity, application/CLI, and implementation-direction rules. Removed the now-unused `JsonValue` command import. `npm run lint` and dependency-cruiser pass: 108 modules / 399 dependencies.
- [x] 5. **Remove the application-to-SQLite type leak, without flattening persistence.** Replaced `Pick<SqliteRunRepository, "list">` with the local `ReportRunReader` capability in `src/application/report-command.ts`. Structural CLI wiring required no runtime change; query-only reader behavior and every repository remain intact. Type-check passed; persistence contract and report tests passed (18 tests).
- [x] 6. **Full clean verification and measurement.** Removed stale `dist/`, type-checked and source-tested before rebuilding, then built fresh and ran the compiled CLI black-box test. Final full verification passes: type-check, 45 test files / 494 passed / 2 skipped, lint, dependency-cruiser (108 modules / 398 dependencies), build, and `git diff --check`. Actual source metrics: 14,539 code; 3,672 comments; 1,084 blanks; 99 `.ts` files; 5 barrels; maximum depth 6; no source orphans; 0 runtime and 7 development dependencies.

## Verification

Baseline status (current dirty tree):

- [x] TypeScript compilation passes.
- [x] Tests pass: 45 files, 494 passed tests, 2 skipped tests.
- [x] Lint passes.
- [x] Build passes and copies Python harness assets.
- [x] Dependency-cruiser passes: 111 modules, 406 dependencies.
- [x] Tests resolve only current source in a clean build environment; a fresh build is required only for compiled-CLI black-box tests.
- [x] Public exports remain intentional: CLI-only boundary confirmed and internal orphan exports removed.
- [x] No deleted module is still imported.
- [x] Boundary validation remains intact; parser, fixed-case, codec, and contract suites pass.
- [x] Security-sensitive cgroup/process behavior is unchanged; no execution sandbox files changed and protected suites pass.
- [x] Error, cleanup, transaction rollback, retry, telemetry containment, and redaction behavior are preserved; relevant protected suites pass.
- [x] Node 22 runtime compatibility remains checked by successful type-check/build with `node:sqlite` and native crypto paths unchanged.
- [x] Dependency lockfile remains unchanged by this implementation; no dependency change was made.
- [x] Final metrics were measured with `tokei -t TypeScript ./src/`, sorted TypeScript file list, dependency counts, barrel count, and max source depth.
- [x] Pre-existing failures are distinguished from refactor regressions: the only clean-`dist` failure was the expected missing compiled binary for black-box tests before fresh build; no regressions remain.
