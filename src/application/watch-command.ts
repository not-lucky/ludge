/**
 * Watch command facade.
 *
 * The facade composes target discovery, the watch mediator, and deferred fixed
 * case execution. It owns no Node watcher implementation and makes no durable
 * write itself: the mediator invokes a completed run's commit closure only
 * after fresh snapshot authorization.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { prepareRunContext } from "./run-context.js";
import type { ExecutionStatus } from "../domain/index.js";
import type { CancellationToken } from "../execution/cancellation.js";
import type {
  FileSystem,
  FileWatchFact,
  FileWatcher,
} from "../execution/filesystem.js";
import type {
  TestCommandDependencies,
  TestDiagnostic,
} from "./test-command.js";
import { executeTestCommandDeferred } from "./test-command.js";
import {
  isRelevantWatchPath,
  scanWatchTarget,
  stableWatchSnapshot,
  WATCH_IGNORED_DIRECTORIES,
  WatchMediator,
  type WatchEventFact,
  type WatchTarget,
} from "../watch/index.js";

/** Parsed watch options consumed independently of the CLI package. */
export interface WatchInvocation {
  readonly slug: string;
  readonly solution?: string;
  readonly debounce?: number;
  /** Fixed-case worker bound used by every watch-triggered test run. */
  readonly jobs?: number;
  readonly unsafeLocal: boolean;
}

/** Terminal watch facade result; command cancellation maps to exit 130. */
export interface WatchApplicationOutcome {
  readonly status: ExecutionStatus;
  readonly result: { readonly state: "stopped"; readonly slug: string } | null;
  readonly diagnostics: readonly TestDiagnostic[];
}

/** Injectable watch command dependencies selected by the composition root. */
export interface WatchCommandDependencies extends Omit<
  TestCommandDependencies,
  "cancellation"
> {
  readonly fileSystem: FileSystem;
  /** Process token. Its cancellation starts mediator draining. */
  readonly cancellation: CancellationToken;
  /** Schedule a callback; production uses wall-time timeout, tests use a fake clock. */
  readonly after: (milliseconds: number, callback: () => void) => () => void;
  /** Fact observer; telemetry is deliberately non-critical. */
  readonly emit?: (fact: WatchEventFact) => void;
  /** Wait until process cancellation. Normally a promise resolved by its token. */
  readonly waitForCancellation?: () => Promise<void>;
  /** Optional observer factory for tests and embeddings. */
  readonly watch?: (
    root: string,
    onFact: (fact: FileWatchFact) => void,
  ) => Promise<FileWatcher>;
}

/**
 * Observe one logical target until process cancellation.
 *
 * Start-up completes its generation-zero rescan before opening the watcher, so
 * a target always has an initial execution while notifications remain hints.
 */
export async function executeWatchCommand(
  command: WatchInvocation,
  dependencies: WatchCommandDependencies,
): Promise<WatchApplicationOutcome> {
  const invocationDirectory = dependencies.invocationDirectory;
  const target: WatchTarget = Object.freeze({
    id: command.slug,
    slug: command.slug,
    problemRoot: resolve(invocationDirectory, "problems", command.slug),
    ...(command.solution === undefined
      ? {}
      : { solutionOverride: resolve(invocationDirectory, command.solution) }),
  });
  let watcher: FileWatcher | undefined;
  let mediator: WatchMediator | undefined;
  let removeCancel = (): void => undefined;
  try {
    if (dependencies.cancellation.isCancellationRequested) {
      return Object.freeze({
        status: "canceled",
        result: { state: "stopped" as const, slug: command.slug },
        diagnostics: Object.freeze([]),
      });
    }
    const prepared = await (dependencies.prepareRun ?? prepareRunContext)({
      invocationDirectory,
      slug: command.slug,
      unsafeLocal: command.unsafeLocal,
      ...(command.solution === undefined ? {} : { solution: command.solution }),
    });
    mediator = new WatchMediator([target], {
      timer: { after: dependencies.after },
      ...(command.debounce === undefined
        ? {}
        : { debounceMs: command.debounce }),
      snapshots: {
        scan: (item) => scanWatchTarget(item, dependencies),
        stable: (item, candidate) =>
          stableWatchSnapshot(
            item,
            candidate,
            delay(dependencies),
            dependencies,
          ),
      },
      createRunId: dependencies.createId ?? randomUUID,
      ...(dependencies.emit === undefined ? {} : { emit: dependencies.emit }),
      run: async (request) => {
        const execution = await executeTestCommandDeferred(
          {
            slug: command.slug,
            unsafeLocal: command.unsafeLocal,
            generation: request.generation,
            ...(command.solution === undefined
              ? {}
              : { solution: command.solution }),
            ...(command.jobs === undefined ? {} : { jobs: command.jobs }),
          },
          {
            ...dependencies,
            cancellation: request.cancellation,
            prepareRun: async () => prepared,
          },
        );
        return Object.freeze({
          result: execution.outcome,
          commit: async () => {
            await execution.commit();
          },
        });
      },
    });
    const activeMediator = mediator;
    // Subscribe before scanning generation zero: a save racing startup remains
    // a hint, but cannot fall in the gap between initial scan and observation.
    const observe =
      dependencies.watch ??
      ((root, onFact) =>
        dependencies.fileSystem.watch(
          root,
          { ignoredDirectoryNames: WATCH_IGNORED_DIRECTORIES },
          onFact,
        ));
    watcher = await observe(invocationDirectory, (fact) =>
      onWatchFact(fact, target, activeMediator),
    );
    await activeMediator.start();
    if (dependencies.cancellation.isCancellationRequested) {
      await activeMediator.drain();
      await watcher.close();
      return Object.freeze({
        status: "canceled",
        result: { state: "stopped" as const, slug: command.slug },
        diagnostics: Object.freeze([]),
      });
    }
    const draining = async (): Promise<void> => {
      await watcher?.close();
      await activeMediator.drain();
    };
    removeCancel = dependencies.cancellation.onCancel(() => {
      void draining();
    });
    await (dependencies.waitForCancellation?.() ??
      waitForCancellation(dependencies.cancellation));
    await draining();
    return Object.freeze({
      status: "canceled",
      result: { state: "stopped" as const, slug: command.slug },
      diagnostics: Object.freeze([]),
    });
  } catch (error) {
    await watcher?.close();
    await mediator?.drain();
    return Object.freeze({
      status: "invalid_input",
      result: null,
      diagnostics: Object.freeze([
        {
          code: "watch_error",
          message:
            error instanceof Error
              ? error.message.slice(0, 256)
              : String(error).slice(0, 256),
        },
      ]),
    });
  } finally {
    removeCancel();
  }
}

function onWatchFact(
  fact: FileWatchFact,
  target: WatchTarget,
  mediator: WatchMediator,
): void {
  switch (fact.kind) {
    case "change":
      if (isRelevantWatchPath(target, fact.path))
        mediator.hint(target.id, "change");
      return;
    case "overflow":
    case "reset":
    case "error":
      mediator.hintAll(fact.kind);
      return;
  }
}

function delay(
  dependencies: WatchCommandDependencies,
): (milliseconds: number) => Promise<void> {
  return (milliseconds) =>
    new Promise<void>((resolveDelay) => {
      dependencies.after(milliseconds, resolveDelay);
    });
}
function waitForCancellation(token: CancellationToken): Promise<void> {
  if (token.isCancellationRequested) return Promise.resolve();
  return new Promise((resolveWait) => {
    token.onCancel(resolveWait);
  });
}
