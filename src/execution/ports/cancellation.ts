/**
 * Cancellation token port.
 *
 * A {@link CancellationToken} is the cooperative signal by which the
 * orchestrator asks in-flight work to stop. It carries no policy of its own: it
 * only observes and reports a cancellation request so that a sandbox run can
 * abort promptly and deterministically. Pairing this token with a process is
 * the Proxy seam where the cancellation boundary is enforced.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/**
 * A read-only, cooperative cancellation signal.
 *
 * Cancellation is one-way: once requested it never reverts. Consumers either
 * poll {@link CancellationToken.isCancellationRequested}, subscribe via
 * {@link CancellationToken.onCancel}, or guard a step with
 * {@link CancellationToken.throwIfCancellationRequested}.
 */
export interface CancellationToken {
  /** Whether cancellation has been requested (latches true, never reverts). */
  readonly isCancellationRequested: boolean;
  /**
   * Register a listener invoked once when cancellation is requested.
   *
   * If cancellation was already requested, implementations invoke the listener
   * as soon as possible. The returned function unsubscribes the listener.
   *
   * @param listener - Callback to run on cancellation.
   * @returns An unsubscribe function.
   */
  onCancel(listener: () => void): () => void;
  /**
   * Throw if cancellation has been requested; otherwise do nothing.
   *
   * Used to fail fast at safe points inside a longer operation.
   */
  throwIfCancellationRequested(): void;
}
