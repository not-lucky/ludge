/**
 * Contract-test scaffold for the execution ports.
 *
 * These suites enumerate the behavioural obligations that any concrete
 * {@link RuntimeAdapter}, {@link Sandbox}, {@link Clock}, {@link CancellationToken},
 * {@link FileSystem}, {@link Profiler}, and {@link ExecutionBackend} implementation
 * must satisfy. They are intentionally `todo` placeholders: tasks 06/07 supply
 * fixtures (including a fake `uv`) that drive these obligations against real
 * adapters. The `import type` block also acts as a compile-time check that the
 * port surface stays stable.
 */

import { describe, it } from "vitest";
import type {
  ArgvInvocation,
  CancellationToken,
  Clock,
  ExecutionBackend,
  FileSystem,
  Profiler,
  RuntimeAdapter,
  RuntimeBundle,
  Sandbox,
} from "../../src/execution/ports/index.js";

// Reference the imported types so the type-only imports are retained and the
// port surface is verified to exist without introducing runtime coupling.
type _PortSurface = [
  ArgvInvocation,
  CancellationToken,
  Clock,
  ExecutionBackend,
  FileSystem,
  Profiler<unknown>,
  RuntimeAdapter,
  RuntimeBundle,
  Sandbox,
];

describe("RuntimeAdapter contract", () => {
  it.todo("describe() returns a stable descriptor with codec versions");
  it.todo("buildInvocation() yields an executable + argv, never a shell string");
  it.todo("buildInvocation() never reads or evaluates the target script");
});

describe("Sandbox contract", () => {
  it.todo("run() resolves with a RawProcessResult on a normal (zero) exit");
  it.todo("run() resolves (does not throw) on a nonzero exit or terminating signal");
  it.todo("run() reports bounded stdout/stderr with truncation flags at the caps");
  it.todo("run() maps wall/CPU/memory breaches to the corresponding observations");
  it.todo("run() aborts promptly when the cancellation token is triggered");
  it.todo("run() executes the target as a child process, never in-process");
});

describe("Clock contract", () => {
  it.todo("monotonicNs() is non-decreasing across successive reads");
  it.todo("wallTimeUtc() returns ISO-8601 UTC text with a Z offset");
});

describe("CancellationToken contract", () => {
  it.todo("isCancellationRequested latches true and never reverts");
  it.todo("onCancel() listeners fire once; late subscribers fire immediately");
  it.todo("onCancel() returns an unsubscribe that prevents later notification");
  it.todo("throwIfCancellationRequested() throws only after cancellation");
});

describe("FileSystem contract", () => {
  it.todo("read() returns the exact file bytes");
  it.todo("stat() reports size, kind, and modified time");
  it.todo("createTempRoot() returns a fresh, isolated directory per call");
  it.todo("watchHints() reports host recursion + coalescing capabilities");
});

describe("Profiler contract", () => {
  it.todo("begin()/finish() folds a RawProcessResult into a profiling record");
  it.todo("profiling never alters the verdict (Decorator, not a policy)");
});

describe("ExecutionBackend contract", () => {
  it.todo("describe() returns a stable backend + runtime identity");
  it.todo("create() returns a bundle whose members all share one backend tag");
  it.todo("bundle codecs and launcher are mutually compatible by construction");
});
