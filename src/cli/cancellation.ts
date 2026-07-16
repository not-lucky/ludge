import type { CancellationToken } from "../execution/cancellation.js";

/** Error thrown by {@link CancellationSource.throwIfCancellationRequested}. */
export class CancellationError extends Error {
  public constructor() {
    super("Cancellation has been requested.");
    this.name = "CancellationError";
  }
}

/**
 * The CLI-owned, write-capable half of a {@link CancellationToken}.
 *
 * Consumers receive this object as the read-only `CancellationToken` port and
 * can consequently only observe cancellation.  The composition/lifecycle
 * owner retains the source and is the only code that calls {@link cancel}.
 * Cancellation is latched: callbacks run once and a subsequent call is a
 * no-op.
 */
export class CancellationSource implements CancellationToken {
  private requested = false;
  private readonly listeners = new Set<() => void>();

  /** A read-only view suitable for passing to execution ports. */
  public get token(): CancellationToken {
    return this;
  }

  /** Whether cancellation has been requested. */
  public get isCancellationRequested(): boolean {
    return this.requested;
  }

  /**
   * Subscribe to the cancellation edge.
   *
   * A late subscriber is called synchronously: it must not assume that
   * registering a callback means work may still be started.  Its unsubscribe
   * function remains harmless in both the early and late-subscription cases.
   */
  public onCancel(listener: () => void): () => void {
    if (this.requested) {
      listener();
      return () => {};
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Throw a stable cancellation error once the source has been cancelled. */
  public throwIfCancellationRequested(): void {
    if (this.requested) {
      throw new CancellationError();
    }
  }

  /**
   * Request cancellation and notify the current listeners exactly once.
   *
   * Take a snapshot before invoking listeners.  This makes unsubscription and
   * subscription from within a listener deterministic, and clearing the set
   * releases closures held by completed actions.
   */
  public cancel(): void {
    if (this.requested) {
      return;
    }

    this.requested = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) {
      listener();
    }
  }
}
