import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeTestCommand } from "../application/test-command.js";
import { executeInitCommand } from "../application/init-command.js";
import { executeReportCommand } from "../application/report-command.js";
import { executeReplayCommand } from "../application/replay-command.js";
import { executeStressTestCommand } from "../application/stress-test-command.js";
import { executeWatchCommand } from "../application/watch-command.js";
import { executeBenchmarkCommand } from "../application/benchmark-command.js";
import { NodeFileSystem } from "../infrastructure/filesystem/node-filesystem.js";
import type { FileSystem } from "../execution/filesystem.js";
import type { WatchEventFact } from "../watch/index.js";
import { classifyTermination } from "../execution/classify.js";
import {
  openSqliteStore,
  type SqliteStore,
} from "../persistence/sqlite/store.js";
import { publishSafely, TelemetryEventFactory } from "../telemetry/index.js";
import type { CancellationSource } from "./cancellation.js";
import {
  createDeferredCommandHandlers,
  type CommandHandlers,
} from "./command.js";
import { ShutdownCoordinator } from "./shutdown.js";
import { outcome } from "./outcome.js";

export interface AppContextDependencies {
  readonly invocationDirectory?: string;
  readonly handlers?: CommandHandlers;
  readonly openStore?: (config: { readonly path: string }) => SqliteStore;
  readonly databasePath?: string;
  readonly shutdown?: ShutdownCoordinator;
  readonly fileSystem?: FileSystem;
  readonly emitWatchFact?: (fact: WatchEventFact) => void;
}

export class AppContext {
  public readonly handlers: CommandHandlers;
  public readonly cancellation: CancellationSource;
  public readonly shutdown: ShutdownCoordinator;

  private store: SqliteStore | undefined;
  private closed = false;

  public constructor(
    private readonly dependencies: AppContextDependencies = {},
  ) {
    this.handlers = dependencies.handlers ?? this.createCommandHandlers();
    // A supplied coordinator remains the one cancellation authority; creating
    // a second source here would leave sandbox actions observing a token that a
    // process signal never cancels.
    this.shutdown = dependencies.shutdown ?? new ShutdownCoordinator();
    this.cancellation = this.shutdown.cancellation;
    this.shutdown.registerCleanup(async () => this.close());
  }

  private createCommandHandlers(): CommandHandlers {
    const deferred = createDeferredCommandHandlers();
    const invocationDirectory =
      this.dependencies.invocationDirectory ?? process.cwd();
    return Object.freeze({
      ...deferred,
      init: async (command) => {
        const application = await executeInitCommand(command.options.slug, {
          invocationDirectory,
          transaction: this.getStore().transaction,
          now: () => nodeClock.wallTimeUtc(),
          createId: randomId,
        });
        return outcome(
          application.status,
          application.result as never,
          application.diagnostics,
        );
      },
      report: async (command) => {
        const application = await executeReportCommand(
          {
            ...(command.options.slug === undefined
              ? {}
              : { slug: command.options.slug }),
            ...(command.options.since === undefined
              ? {}
              : { since: command.options.since }),
          },
          { runs: this.getStore().runs },
        );
        return outcome(
          application.status,
          application.result as never,
          application.diagnostics,
        );
      },
      "stress-test": async (command) => {
        const application = await executeStressTestCommand(
          {
            slug: command.options.slug,
            ...(command.options.generator === undefined
              ? {}
              : { generator: command.options.generator }),
            ...(command.options.naive === undefined
              ? {}
              : { naive: command.options.naive }),
            ...(command.options.solution === undefined
              ? {}
              : { solution: command.options.solution }),
            ...(command.options.seed === undefined
              ? {}
              : { seed: command.options.seed }),
            ...(command.options.cases === undefined
              ? {}
              : { cases: command.options.cases }),
            ...(command.options.duration === undefined
              ? {}
              : { duration: command.options.duration }),
            ...(command.options.jobs === undefined
              ? {}
              : { jobs: command.options.jobs }),
            shrink: command.options.shrink,
            unsafeLocal: command.options.unsafeLocal,
          },
          {
            invocationDirectory,
            cancellation: this.cancellation,
            clock: nodeClock,
            transaction: this.getStore().transaction,
            classifyTermination,
          },
        );
        return outcome(
          application.status,
          application.result as never,
          application.diagnostics,
        );
      },
      replay: async (command) => {
        const store = this.getStore();
        const application = await executeReplayCommand(
          {
            artifactId: command.options.artifactId,
            unsafeLocal: command.options.unsafeLocal,
          },
          {
            invocationDirectory,
            cancellation: this.cancellation,
            clock: nodeClock,
            classifyTermination,
            artifacts: store.artifactLookup,
            transaction: store.transaction,
          },
        );
        return outcome(
          application.status,
          application.result as never,
          application.diagnostics,
        );
      },
      watch: async (command) => {
        const watchEvents =
          this.dependencies.emitWatchFact ??
          createWatchTelemetryEmitter(command.options.slug);
        const application = await executeWatchCommand(
          {
            slug: command.options.slug,
            unsafeLocal: command.options.unsafeLocal,
            ...(command.options.solution === undefined
              ? {}
              : { solution: command.options.solution }),
            ...(command.options.debounce === undefined
              ? {}
              : { debounce: command.options.debounce }),
            ...(command.options.jobs === undefined
              ? {}
              : { jobs: command.options.jobs }),
          },
          {
            invocationDirectory,
            cancellation: this.cancellation,
            clock: nodeClock,
            transaction: this.getStore().transaction,
            readText: (path) => readFile(path, "utf8"),
            classifyTermination,
            fileSystem: this.dependencies.fileSystem ?? new NodeFileSystem(),
            after: nodeAfter,
            emit: watchEvents,
          },
        );
        return outcome(
          application.status,
          application.result as never,
          application.diagnostics,
        );
      },
      benchmark: async (command) => {
        const application = await executeBenchmarkCommand(
          {
            slug: command.options.slug,
            solutions: command.options.solutions,
            ...(command.options.cases === undefined
              ? {}
              : { cases: command.options.cases }),
            ...(command.options.warmup === undefined
              ? {}
              : { warmup: command.options.warmup }),
            ...(command.options.samples === undefined
              ? {}
              : { samples: command.options.samples }),
            unsafeLocal: command.options.unsafeLocal,
          },
          {
            invocationDirectory,
            cancellation: this.cancellation,
            clock: nodeClock,
            transaction: this.getStore().transaction,
            classifyTermination,
            readText: (path) => readFile(path, "utf8"),
            runtimeMetadata: () => ({
              pythonVersion: process.env.PALESTRA_PYTHON_VERSION ?? "python-uv",
              uvVersion: process.env.PALESTRA_UV_VERSION ?? "unknown",
              sandboxMode: "linux-cgroup-v2",
              databaseMode: "sqlite-wal-local",
            }),
          },
        );
        return outcome(
          application.status,
          application.result as never,
          application.diagnostics,
        );
      },
      test: async (command) => {
        const application = await executeTestCommand(
          {
            slug: command.options.slug,
            unsafeLocal: command.options.unsafeLocal,
            ...(command.options.solution === undefined
              ? {}
              : { solution: command.options.solution }),
            ...(command.options.case === undefined
              ? {}
              : { case: command.options.case }),
            ...(command.options.jobs === undefined
              ? {}
              : { jobs: command.options.jobs }),
          },
          {
            invocationDirectory,
            cancellation: this.cancellation,
            clock: nodeClock,
            transaction: this.getStore().transaction,
            readText: (path) => readFile(path, "utf8"),
            classifyTermination,
          },
        );
        return outcome(
          application.status,
          application.result as never,
          application.diagnostics,
        );
      },
    });
  }

  public getStore(): SqliteStore {
    if (this.closed) {
      throw new Error("AppContext is closed");
    }
    if (this.store === undefined) {
      const invocationDirectory =
        this.dependencies.invocationDirectory ?? process.cwd();
      const path =
        this.dependencies.databasePath ??
        resolve(invocationDirectory, ".palestra", "judge.sqlite");
      this.store = (this.dependencies.openStore ?? openSqliteStore)({ path });
    }
    return this.store;
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.store?.close();
    this.store = undefined;
  }
}

let processContext: AppContext | undefined;

export function createAppContext(
  dependencies?: AppContextDependencies,
): AppContext {
  if (dependencies !== undefined) {
    return new AppContext(dependencies);
  }
  processContext ??= new AppContext();
  return processContext;
}

export function releaseAppContext(context: AppContext): void {
  if (processContext === context) {
    processContext = undefined;
  }
}

const randomId = (): string => randomUUID();

const nodeClock = Object.freeze({
  monotonicNs: (): bigint => process.hrtime.bigint(),
  wallTimeUtc: (): string => new Date().toISOString(),
});

function nodeAfter(milliseconds: number, callback: () => void): () => void {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
}

function createWatchTelemetryEmitter(
  slug: string,
): (fact: WatchEventFact) => void {
  const factory = new TelemetryEventFactory(nodeClock);
  const sinks = [
    {
      emit: (event: unknown) =>
        process.stderr.write(`${JSON.stringify(event)}\n`),
    },
  ];
  return (fact) =>
    publishSafely(
      sinks,
      factory.create({
        level: fact.event === "watch.cancel" ? "warn" : "info",
        event: fact.event,
        runId: fact.runId,
        caseId: null,
        generation: fact.generation,
        component: "watch",
        problemSlug: slug,
        implementationId: null,
        data: Object.freeze({
          target: fact.target,
          trigger: fact.trigger,
          ...(fact.reason === undefined ? {} : { reason: fact.reason }),
        }),
      }),
    );
}
