/**
 * Immutable contracts shared by watch rescan and scheduling policy.
 *
 * A snapshot deliberately includes both metadata and a content hash. Metadata
 * makes ordinary edits cheap to recognize, while a hash closes timestamp/size
 * collisions such as atomic replacement with a preserved mtime.
 */

import type { Generation } from "../domain/index.js";
import type { CancellationToken } from "../execution/cancellation.js";

/** Directories ignored by both discovery and notification filtering. */
export const WATCH_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".palestra",
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Why the mediator has requested a configured-target rescan. */
export type WatchTrigger =
  "initial" | "change" | "overflow" | "reset" | "error";

/** A single regular-file observation, or an intentional absent file. */
export interface WatchFileSnapshot {
  /** Absolute candidate path. */
  readonly path: string;
  /** `null` represents a configured file that did not exist when scanned. */
  readonly file: Readonly<{
    readonly sizeBytes: number;
    readonly modifiedMsUtc: number;
    readonly sha256: string;
  }> | null;
}

/** The input/configuration state a target must retain until commit. */
export interface WatchTargetSnapshot {
  /** Stable logical problem target, normally the requested slug. */
  readonly target: string;
  /** All configured candidates, in deterministic lexical order. */
  readonly files: readonly WatchFileSnapshot[];
  /** Hash of the solution/case inputs consumed by a generation. */
  readonly inputHash: string;
  /** Hash of problem configuration and resolved target identity. */
  readonly configurationHash: string;
}

/** A target whose generation is scheduled by the mediator. */
export interface WatchTarget {
  /** Stable logical target identifier used for coalescing. */
  readonly id: string;
  /** Problem slug used in telemetry correlation. */
  readonly slug: string;
  /** Absolute `problems/<slug>` path. */
  readonly problemRoot: string;
  /** Absolute explicit CLI solution override, when supplied. */
  readonly solutionOverride?: string;
}

/** Work handed to an injected execution callback after slot authorization. */
export interface WatchRunRequest {
  readonly target: WatchTarget;
  readonly generation: Generation;
  readonly trigger: WatchTrigger;
  readonly snapshot: WatchTargetSnapshot;
  readonly runId: string;
  readonly cancellation: CancellationToken;
}

/** Settlement facts emitted by one child run. */
export interface WatchRunResult {
  /** JSON-safe target verdict/result supplied by the execution facade. */
  readonly result: unknown;
  /** Commit writes artifacts/persistence only after mediator authorization. */
  readonly commit: () => Promise<void>;
}

/** Structured policy fact, independently timestamped by telemetry adapters. */
export interface WatchEventFact {
  readonly event: "watch.change" | "watch.cancel";
  readonly target: string;
  readonly slug: string;
  readonly generation: Generation;
  readonly trigger: WatchTrigger;
  readonly runId: string;
  /** Bounded reason when cancellation/stale completion prevented commit. */
  readonly reason?: string;
}
