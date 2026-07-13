/**
 * Process-local CLI composition context.
 *
 * The context owns only infrastructure lifetime and adapter selection. Command
 * use cases receive handler dependencies through its facade; they do not import
 * this module or construct concrete adapters themselves. This keeps the CLI as
 * the sole composition root while allowing later tasks to replace a deferred
 * handler with an application service without changing command parsing.
 */

import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExecutionBackend, RuntimeBundle } from "../execution/ports/index.js";
import { createPythonRuntimeAdapter, createPythonRuntimeConfig, defaultHarnessEntrypoint, pythonUvDescriptor, PYTHON_UV_RUNTIME_ID } from "../execution/runtimes/python/index.js";
import { createLinuxSandbox, createLinuxSandboxConfig } from "../execution/sandbox/linux/index.js";
import type { EffectiveConfig, ConfigProbes } from "../infrastructure/config/index.js";
import { executeTestCommand } from "../application/test-command.js";
import { executeInitCommand } from "../application/init-command.js";
import { executeReportCommand } from "../application/report-command.js";
import { executeReplayCommand } from "../application/replay-command.js";
import { executeStressTestCommand } from "../application/stress-test-command.js";
import { classifyTermination } from "../execution/sandbox/linux/index.js";
import { createTaggedJsonlV1Codec } from "../judging/codec/index.js";
import { openSqliteStore, type SqliteStore } from "../persistence/sqlite/index.js";
import { createExecutionProfiler } from "../telemetry/index.js";
import type { ExecutionProfile } from "../telemetry/index.js";
import type { CancellationSource } from "./cancellation.js";
import {
  createDeferredCommandHandlers,
  type CommandHandlers,
} from "./command.js";
import { ShutdownCoordinator } from "./shutdown.js";
import { outcome } from "./outcome.js";

/** Stable identifier for the built-in Python/Linux execution backend. */
export const PYTHON_UV_LINUX_BACKEND_ID = "python-uv-linux" as const;

/** The concrete bundle type supplied by the built-in backend. */
export type PythonUvLinuxBundle = RuntimeBundle<
  typeof PYTHON_UV_LINUX_BACKEND_ID,
  unknown,
  ExecutionProfile
>;

/**
 * Registry for execution backends selected at the composition root.
 *
 * The registry deliberately stores factories rather than mutable live bundles:
 * a bundle contains per-problem paths and validated limits, and therefore must
 * be created only after a command has resolved an effective configuration.
 */
export class ExecutionBackendRegistry {
  private readonly backends = new Map<string, ExecutionBackend>();

  /** Register exactly one backend for an identifier. */
  public register(backend: ExecutionBackend): void {
    const id = backend.describe().id;
    if (this.backends.has(id)) {
      throw new Error(`execution backend is already registered: ${id}`);
    }
    this.backends.set(id, backend);
  }

  /** Look up a selected backend, failing explicitly for an unsupported id. */
  public require(id: string): ExecutionBackend {
    const backend = this.backends.get(id);
    if (backend === undefined) {
      throw new Error(`no execution backend registered for runtime: ${id}`);
    }
    return backend;
  }

  /** Report registered backend descriptors for diagnostics and future reports. */
  public describe(): readonly ReturnType<ExecutionBackend["describe"]>[] {
    return Object.freeze([...this.backends.values()].map((backend) => backend.describe()));
  }
}

/** Dependencies that make resource opening deterministic in tests. */
export interface AppContextDependencies {
  /** Invocation directory used for the default persistence location. */
  readonly invocationDirectory?: string;
  /** Command handlers; omitted handlers are replaced with deferred defaults. */
  readonly handlers?: CommandHandlers;
  /** Backend registry. A new built-in registry is created when omitted. */
  readonly backends?: ExecutionBackendRegistry;
  /** Opens the SQLite store on first request. */
  readonly openStore?: (config: { readonly path: string }) => SqliteStore;
  /** Location of the durable SQLite file. */
  readonly databasePath?: string;
  /** Optional factory used by tests to observe shutdown behavior. */
  readonly shutdown?: ShutdownCoordinator;
  /** Host prerequisite probes; production defaults to bounded Node probes. */
  readonly configProbes?: ConfigProbes;
}

/**
 * Process-local resource owner for one CLI bootstrap.
 *
 * It is intentionally instantiated by `createAppContext` rather than hidden in
 * a module global: one process has one owner in production, while tests can
 * build isolated contexts. It holds no problem, run, or verdict state.
 */
export class AppContext {
  /** Typed command facade replaced by application services in later tasks. */
  public readonly handlers: CommandHandlers;
  /** Execution backend factory registry owned by this process. */
  public readonly backends: ExecutionBackendRegistry;
  /** Cancellation source shared with active command handlers. */
  public readonly cancellation: CancellationSource;
  /** One-way shutdown coordinator for signals and final resource cleanup. */
  public readonly shutdown: ShutdownCoordinator;

  private store: SqliteStore | undefined;
  private closed = false;

  public constructor(private readonly dependencies: AppContextDependencies = {}) {
    this.backends = dependencies.backends ?? createBuiltInBackendRegistry();
    this.handlers = dependencies.handlers ?? this.createCommandHandlers();
    // A supplied coordinator remains the one cancellation authority; creating
    // a second source here would leave sandbox actions observing a token that a
    // process signal never cancels.
    this.shutdown = dependencies.shutdown ?? new ShutdownCoordinator();
    this.cancellation = this.shutdown.cancellation;
    this.shutdown.registerCleanup(async () => this.close());
  }

  /** Install only task-12's concrete facade; all future handlers remain deferred. */
  private createCommandHandlers(): CommandHandlers {
    const deferred = createDeferredCommandHandlers();
    const invocationDirectory = this.dependencies.invocationDirectory ?? process.cwd();
    return Object.freeze({
      ...deferred,
      init: async (command) => {
        const application = await executeInitCommand(command.options.slug, {
          invocationDirectory,
          transaction: this.getStore().transaction,
          now: () => nodeClock.wallTimeUtc(),
          createId: randomId,
        });
        return outcome(application.status, application.result as never, application.diagnostics);
      },
      report: async (command) => {
        const application = await executeReportCommand({
          ...(command.options.slug === undefined ? {} : { slug: command.options.slug }),
          ...(command.options.since === undefined ? {} : { since: command.options.since }),
        }, { runs: this.getStore().runs });
        return outcome(application.status, application.result as never, application.diagnostics);
      },
      "stress-test": async (command) => {
        const application = await executeStressTestCommand({
          slug: command.options.slug,
          ...(command.options.generator === undefined ? {} : { generator: command.options.generator }),
          ...(command.options.naive === undefined ? {} : { naive: command.options.naive }),
          ...(command.options.solution === undefined ? {} : { solution: command.options.solution }),
          ...(command.options.seed === undefined ? {} : { seed: command.options.seed }),
          ...(command.options.cases === undefined ? {} : { cases: command.options.cases }),
          ...(command.options.duration === undefined ? {} : { duration: command.options.duration }),
          ...(command.options.jobs === undefined ? {} : { jobs: command.options.jobs }),
          shrink: command.options.shrink,
          unsafeLocal: command.options.unsafeLocal,
        }, {
          invocationDirectory, environment: process.env, cancellation: this.cancellation, clock: nodeClock,
          probes: this.dependencies.configProbes ?? nodeConfigProbes, supportedRuntimes: new Set([PYTHON_UV_RUNTIME_ID]), requiredControls: ["cgroup"],
          createBundle: createPythonUvLinuxBundle, transaction: this.getStore().transaction, classifyTermination,
        });
        return outcome(application.status, application.result as never, application.diagnostics);
      },
      replay: async (command) => {
        const store = this.getStore();
        const application = await executeReplayCommand({ artifactId: command.options.artifactId, unsafeLocal: command.options.unsafeLocal }, {
          invocationDirectory, environment: process.env, cancellation: this.cancellation, clock: nodeClock,
          probes: this.dependencies.configProbes ?? nodeConfigProbes, supportedRuntimes: new Set([PYTHON_UV_RUNTIME_ID]), requiredControls: ["cgroup"],
          createBundle: createPythonUvLinuxBundle, classifyTermination, artifacts: store.artifactLookup, transaction: store.transaction,
        });
        return outcome(application.status, application.result as never, application.diagnostics);
      },
      test: async (command) => {
        const application = await executeTestCommand({
          slug: command.options.slug,
          unsafeLocal: command.options.unsafeLocal,
          ...(command.options.solution === undefined ? {} : { solution: command.options.solution }),
          ...(command.options.case === undefined ? {} : { case: command.options.case }),
        }, {
        invocationDirectory,
        environment: process.env,
        cancellation: this.cancellation,
        clock: nodeClock,
        probes: this.dependencies.configProbes ?? nodeConfigProbes,
        supportedRuntimes: new Set([PYTHON_UV_RUNTIME_ID]),
        requiredControls: ["cgroup"],
        createBundle: (effective) => createPythonUvLinuxBundle(effective),
        transaction: this.getStore().transaction,
        readText: (path) => readFile(path, "utf8"),
        classifyTermination,
      });
        return outcome(application.status, application.result as never, application.diagnostics);
      },
    });
  }

  /**
   * Lazily open the process SQLite store.
   *
   * Parsing and deferred command dispatch never call this method, so they do
   * not require a local SQLite-capable filesystem. Concrete persistence use
   * cases request it only after their command/configuration validation.
   */
  public getStore(): SqliteStore {
    if (this.closed) {
      throw new Error("AppContext is closed");
    }
    if (this.store === undefined) {
      const invocationDirectory = this.dependencies.invocationDirectory ?? process.cwd();
      const path = this.dependencies.databasePath ?? resolve(invocationDirectory, ".palestra", "judge.sqlite");
      this.store = (this.dependencies.openStore ?? openSqliteStore)({ path });
    }
    return this.store;
  }

  /** Close all lazily opened resources. Safe and idempotent. */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.store?.close();
    this.store = undefined;
  }
}

/** The lazily allocated production context; tests use `new AppContext()` directly. */
let processContext: AppContext | undefined;

/**
 * Return the narrow process-local AppContext singleton.
 *
 * Supplying dependencies intentionally constructs an isolated context instead:
 * dependency injection is a test/embedding boundary and must never mutate the
 * production singleton. The singleton owns infrastructure only, never domain
 * state, and is cleared after close so a programmatic embedding can bootstrap a
 * fresh invocation after explicit shutdown.
 */
export function createAppContext(dependencies?: AppContextDependencies): AppContext {
  if (dependencies !== undefined) {
    return new AppContext(dependencies);
  }
  processContext ??= new AppContext();
  return processContext;
}

/** Reset the process owner after it has released every resource. */
export function releaseAppContext(context: AppContext): void {
  if (processContext === context) {
    processContext = undefined;
  }
}

/**
 * Build the built-in backend registry.
 *
 * The descriptor is registered under the runtime id in `problem.yaml`
 * (`python-uv`), while every component shares the more specific coherence tag
 * `python-uv-linux`.
 */
export function createBuiltInBackendRegistry(): ExecutionBackendRegistry {
  const registry = new ExecutionBackendRegistry();
  registry.register(createPythonUvLinuxBackend());
  return registry;
}

/**
 * Create the concrete backend factory selected by this CLI build.
 *
 * Because `ExecutionBackend.create()` has no configuration parameter, the
 * backend captures the already validated effective configuration. Later use
 * cases create one factory per resolved problem and register/consume it through
 * the registry facade. The standalone default factory is deliberately not
 * exposed without validated settings.
 */
export function createPythonUvLinuxBackend(
  effective?: EffectiveConfig,
): ExecutionBackend<typeof PYTHON_UV_LINUX_BACKEND_ID, unknown, ExecutionProfile> {
  return {
    describe() {
      return {
        id: PYTHON_UV_RUNTIME_ID,
        displayName: "Python via uv with Linux sandbox",
        runtime: pythonUvDescriptor(),
      };
    },
    create(): PythonUvLinuxBundle {
      if (effective === undefined) {
        throw new Error("a validated effective configuration is required to create a Python backend bundle");
      }
      return createPythonUvLinuxBundle(effective);
    },
  };
}

/**
 * Create a coherent Python/Linux bundle from validated effective settings.
 *
 * Callers must have used `assertConfigurationValid` first; this function only
 * binds those checked paths to concrete adapter factories and performs no
 * fallback probing or unsafe platform downgrade.
 */
export function createPythonUvLinuxBundle(effective: EffectiveConfig): PythonUvLinuxBundle {
  const paths = effective.globalPaths;
  const uvPath = requirePath(paths.uvPath, "uvPath");
  const pythonPath = requirePath(paths.pythonPath, "pythonPath");
  const uvCacheDir = requirePath(paths.uvCacheDir, "uvCacheDir");
  const tempBaseDir = requirePath(paths.tempBaseDir, "tempBaseDir");
  const cgroupParentPath = requirePath(paths.cgroupParentPath, "cgroupParentPath");
  const backendId = PYTHON_UV_LINUX_BACKEND_ID;
  const workingDirectory = effective.problemRoot;
  const pathEnv = dirname(uvPath);
  const runtime = createPythonRuntimeAdapter(
    backendId,
    createPythonRuntimeConfig({
      uvPath,
      pythonPath,
      harnessEntrypoint: defaultHarnessEntrypoint(),
      workingDirectory,
      pathEnv,
      locale: "C.UTF-8",
      uvCacheDir,
      defaultEntrySymbol: "solution",
    }),
  );
  const sandboxConfig = createLinuxSandboxConfig({
    workingDirectory,
    environment: {
      PATH: pathEnv,
      LANG: "C.UTF-8",
      PYTHONUNBUFFERED: "1",
      UV_CACHE_DIR: uvCacheDir,
    },
    readonlyPaths: Object.freeze([workingDirectory, dirname(defaultHarnessEntrypoint()), uvPath, pythonPath]),
    cgroupParentPath,
    tempBaseDir,
  });
  return Object.freeze({
    backendId,
    runtime,
    inputCodec: createTaggedJsonlV1Codec(backendId),
    outputCodec: createTaggedJsonlV1Codec(backendId),
    sandbox: createLinuxSandbox(backendId, sandboxConfig),
    profiler: createExecutionProfiler(backendId, sandboxConfig.clock),
  });
}

/** Process-level clock injected into the application facade. */
const randomId = (): string => randomUUID();

const nodeClock = Object.freeze({
  monotonicNs: (): bigint => process.hrtime.bigint(),
  wallTimeUtc: (): string => new Date().toISOString(),
});

/** Minimal real host probes used before a production test command starts. */
const nodeConfigProbes: ConfigProbes = Object.freeze({
  async isExecutable(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async availableControls() {
    // The concrete sandbox makes the final authoritative install/probe decision.
    // This early check keeps configuration failures actionable before a run.
    if (process.platform !== "linux") return new Set<never>();
    try {
      await access("/sys/fs/cgroup/cgroup.controllers", constants.R_OK);
      return new Set(["cgroup"] as const);
    } catch {
      return new Set<never>();
    }
  },
});

function requirePath(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`validated effective configuration is missing global path: ${name}`);
  }
  return value;
}
