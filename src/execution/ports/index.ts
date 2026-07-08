/**
 * Public surface of the execution ports.
 *
 * These runtime-neutral contracts describe the process boundary: how a request
 * becomes an invocation ({@link RuntimeAdapter}), how it runs under limits
 * ({@link Sandbox}), how time, cancellation, filesystem, and profiling are
 * observed, and how a backend bundles a coherent set of components
 * ({@link ExecutionBackend}). Concrete adapters arrive in tasks 06 (Python) and
 * 07 (Linux sandbox). This barrel is type-only and imports no adapter.
 */

// Invocation value type.
export type { ArgvInvocation } from "./invocation.js";

// Runtime adapter and its descriptor.
export type { RuntimeAdapter, RuntimeDescriptor } from "./runtime.js";

// Sandbox.
export type { Sandbox } from "./sandbox.js";

// Clock.
export type { Clock } from "./clock.js";

// Cancellation.
export type { CancellationToken } from "./cancellation.js";

// Filesystem.
export type { FileStat, FileSystem, FileWatchHints } from "./filesystem.js";

// Profiler.
export type { Profiler, ProfileScope } from "./profiler.js";

// ExecutionBackend abstract factory and its bundle.
export type {
  BackendDescriptor,
  ExecutionBackend,
  RuntimeBundle,
} from "./backend.js";
