import { CancellationSource } from "./cancellation.js";

/** Signals for which the CLI performs graceful, cooperative shutdown. */
export type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Removes a signal listener installed by {@link SignalRegistrar}. */
export type RemoveSignalListener = () => void;

/** Injectable process boundary; production callers may wrap `process.on`. */
export type SignalRegistrar = (
  signal: ShutdownSignal,
  listener: () => void,
) => RemoveSignalListener;

/** Injectable process boundary used after signal-driven draining completes. */
export type ExitHandler = (exitCode: number) => void;

/** A resource action that must complete before process resources are released. */
export type Cleanup = () => void | Promise<void>;

/** A lease held while an action is in flight. */
export interface ActiveWork {
  /** Mark this action complete. Calling this more than once is harmless. */
  complete(): void;
}

/** Options for the process-local shutdown coordinator. */
export interface ShutdownCoordinatorOptions {
  /** Source shared with cancellable actions. A fresh source is the default. */
  readonly cancellation?: CancellationSource;
  /** Signal adapter, normally installed by the executable bootstrap. */
  readonly registerSignal?: SignalRegistrar;
  /** Exit adapter. Defaults to assigning Node's `process.exitCode`. */
  readonly exit?: ExitHandler;
  /** Receives cleanup errors after every cleanup has nevertheless been tried. */
  readonly onCleanupError?: (error: unknown) => void;
}

type ShutdownState = "running" | "draining" | "closed";

interface CleanupEntry {
  readonly cleanup: Cleanup;
  active: boolean;
}

/**
 * Coordinates the single, one-way process shutdown path.
 *
 * The ordering is deliberately strict: mark the coordinator draining (so new
 * dispatch cannot begin), cancel active actions, wait for those actions to
 * acknowledge completion, then clean resources in reverse registration order.
 * Reverse order lets a child/transaction be released before the store or other
 * process-wide resource on which it depends.  Repeated signals and repeated
 * explicit shutdown calls share one drain promise and never execute cleanup or
 * exit more than once.
 */
export class ShutdownCoordinator {
  public readonly cancellation: CancellationSource;

  private readonly registerSignal: SignalRegistrar;
  private readonly exit: ExitHandler;
  private readonly onCleanupError: (error: unknown) => void;
  private state: ShutdownState = "running";
  private activeWork = 0;
  private activeWorkDrained: Promise<void> | undefined;
  private resolveActiveWorkDrained: (() => void) | undefined;
  private drainPromise: Promise<void> | undefined;
  private signalRemovers: RemoveSignalListener[] = [];
  private readonly cleanups: CleanupEntry[] = [];
  private exitedForSignal = false;

  public constructor(options: ShutdownCoordinatorOptions = {}) {
    this.cancellation = options.cancellation ?? new CancellationSource();
    this.registerSignal = options.registerSignal ?? registerNodeSignal;
    this.exit = options.exit ?? setNodeExitCode;
    this.onCleanupError = options.onCleanupError ?? (() => {});
  }

  /** True until shutdown starts; dispatch must refuse work once false. */
  public get isAcceptingWork(): boolean {
    return this.state === "running";
  }

  /** Whether cancellation/draining has started. */
  public get isDraining(): boolean {
    return this.state !== "running";
  }

  /** Whether all active work and registered cleanup have completed. */
  public get isClosed(): boolean {
    return this.state === "closed";
  }

  /**
   * Install SIGINT/SIGTERM handlers once. This is explicit so importing or
   * constructing a CLI context never mutates global process state in tests.
   */
  public installSignalHandlers(): void {
    if (this.signalRemovers.length > 0) {
      return;
    }

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      this.signalRemovers.push(
        this.registerSignal(signal, () => {
          void this.shutdownFromSignal();
        }),
      );
    }
  }

  /** Alias used by composition roots that treat installation as lifecycle setup. */
  public install(): void {
    this.installSignalHandlers();
  }

  /** Remove installed handlers without initiating shutdown. Idempotent. */
  public uninstallSignalHandlers(): void {
    const removers = this.signalRemovers;
    this.signalRemovers = [];
    for (const remove of removers) {
      remove();
    }
  }

  /** Alias for lifecycle owners. */
  public disposeSignalHandlers(): void {
    this.uninstallSignalHandlers();
  }

  /**
   * Attempt to begin an action. `undefined` means shutdown already won the
   * race and the caller must not dispatch the action.
   */
  public beginWork(): ActiveWork | undefined {
    if (!this.isAcceptingWork) {
      return undefined;
    }

    this.activeWork += 1;
    let complete = false;
    return {
      complete: () => {
        if (complete) {
          return;
        }
        complete = true;
        this.activeWork -= 1;
        if (this.activeWork === 0) {
          this.resolveActiveWorkDrained?.();
        }
      },
    };
  }

  /**
   * Register process/resource cleanup. Registrations are LIFO and may be made
   * by a cancellation listener while draining; those late entries are included
   * before the drain finishes. The returned function removes an entry that has
   * not started yet and is itself idempotent.
   */
  public registerCleanup(cleanup: Cleanup): () => void {
    const entry: CleanupEntry = { cleanup, active: true };
    this.cleanups.push(entry);
    return () => {
      entry.active = false;
    };
  }

  /**
   * Start graceful shutdown and await active work plus every registered
   * cleanup. It is safe to call more than once; all callers receive the same
   * promise. This method intentionally does not call the exit adapter because
   * ordinary application cleanup is not necessarily process termination.
   */
  public shutdown(): Promise<void> {
    if (this.drainPromise !== undefined) {
      return this.drainPromise;
    }

    this.state = "draining";
    this.drainPromise = this.drain();
    return this.drainPromise;
  }

  private async shutdownFromSignal(): Promise<void> {
    await this.shutdown();
    if (!this.exitedForSignal) {
      this.exitedForSignal = true;
      this.exit(130);
    }
  }

  private async drain(): Promise<void> {
    try {
      this.cancellation.cancel();
    } catch (error) {
      // A faulty observer must not leave children/resources running.
      this.reportCleanupError(error);
    }

    await this.waitForActiveWork();
    await this.runCleanups();
    this.state = "closed";
    this.uninstallSignalHandlers();
  }

  private waitForActiveWork(): Promise<void> {
    if (this.activeWork === 0) {
      return Promise.resolve();
    }
    this.activeWorkDrained ??= new Promise<void>((resolve) => {
      this.resolveActiveWorkDrained = resolve;
    });
    return this.activeWorkDrained;
  }

  private async runCleanups(): Promise<void> {
    // New cleanup registered by a cancellation callback is appended and is
    // therefore observed by this loop before the coordinator becomes closed.
    while (this.cleanups.length > 0) {
      const entry = this.cleanups.pop();
      if (entry === undefined || !entry.active) {
        continue;
      }
      entry.active = false;
      try {
        await entry.cleanup();
      } catch (error) {
        this.reportCleanupError(error);
      }
    }
  }

  private reportCleanupError(error: unknown): void {
    try {
      this.onCleanupError(error);
    } catch {
      // Reporting is observational and must not interrupt remaining cleanup.
    }
  }
}

function registerNodeSignal(
  signal: ShutdownSignal,
  listener: () => void,
): RemoveSignalListener {
  process.on(signal, listener);
  return () => process.off(signal, listener);
}

function setNodeExitCode(exitCode: number): void {
  process.exitCode = exitCode;
}
