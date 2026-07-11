/**
 * Process-local single-writer serialization and busy-retry.
 *
 * The store commits through exactly one writer connection. Because `node:sqlite`
 * is synchronous, a single statement never interleaves with another — but the
 * async port surface means several callers can hold an in-flight `transact`
 * promise at once. {@link WriterQueue} serializes those callers onto a single
 * promise chain, so at most one write transaction is ever open, matching the
 * spec's "process-local writer queue" requirement.
 *
 * {@link withBusyRetry} adds bounded exponential backoff around a job that may
 * hit `SQLITE_BUSY` despite the connection's `busy_timeout`. After the bounded
 * attempts are exhausted it surfaces a {@link PersistenceBusyError} rather than
 * blocking forever — a stuck writer stays observable.
 *
 * This is an adapter module; it uses only timers and imports no driver.
 */

import { PersistenceBusyError } from "./errors.js";

/** Tunable bounds for {@link withBusyRetry}. */
export interface BusyRetryOptions {
  /** Delay before the second attempt, in milliseconds. */
  readonly baseDelayMs: number;
  /** Multiplier applied to the delay after each failed attempt. */
  readonly factor: number;
  /** Upper bound on any single backoff delay, in milliseconds. */
  readonly maxDelayMs: number;
  /** Total number of attempts (including the first) before giving up. */
  readonly maxAttempts: number;
}

/** The default backoff: 5ms, doubling, capped at 200ms, up to 6 attempts. */
export const DEFAULT_BUSY_RETRY: BusyRetryOptions = Object.freeze({
  baseDelayMs: 5,
  factor: 2,
  maxDelayMs: 200,
  maxAttempts: 6,
});

/** Primary and extended SQLite result codes that mean "retry later". */
const BUSY_ERRCODES: ReadonlySet<number> = new Set([
  5, // SQLITE_BUSY
  6, // SQLITE_LOCKED
  261, // SQLITE_BUSY_RECOVERY
  517, // SQLITE_BUSY_SNAPSHOT
  773, // SQLITE_BUSY_TIMEOUT
]);

/**
 * Whether an error represents transient SQLite contention worth retrying.
 *
 * @param error - The thrown value to classify.
 * @returns `true` when the error is a `SQLITE_BUSY`/`SQLITE_LOCKED` condition.
 */
export function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode === "number" && BUSY_ERRCODES.has(errcode)) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /\b(busy|locked)\b/iu.test(message);
}

/** A sleep function, injectable so tests need not wait on real timers. */
export type Sleeper = (ms: number) => Promise<void>;

/** The default sleeper backed by `setTimeout`. */
const realSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `job`, retrying transient `SQLITE_BUSY`/`SQLITE_LOCKED` failures with
 * bounded exponential backoff.
 *
 * A non-busy error is rethrown immediately. When every attempt is exhausted the
 * final busy failure is surfaced as a {@link PersistenceBusyError}.
 *
 * @typeParam T - The job's result type.
 * @param job - The (possibly synchronous) unit of work to attempt.
 * @param options - Backoff bounds (defaults to {@link DEFAULT_BUSY_RETRY}).
 * @param sleep - Injectable delay function (defaults to `setTimeout`).
 * @returns The job's result.
 * @throws {PersistenceBusyError} If the database stays busy past the bound.
 */
export async function withBusyRetry<T>(
  job: () => T | Promise<T>,
  options: BusyRetryOptions = DEFAULT_BUSY_RETRY,
  sleep: Sleeper = realSleep,
): Promise<T> {
  let delay = options.baseDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (error) {
      if (!isBusyError(error)) {
        throw error;
      }
      if (attempt >= options.maxAttempts) {
        throw new PersistenceBusyError(attempt);
      }
      await sleep(Math.min(delay, options.maxDelayMs));
      delay *= options.factor;
    }
  }
}

/**
 * A promise-chained queue that runs enqueued jobs strictly one at a time.
 *
 * Each job waits for the previous job to settle (whether it resolved or
 * rejected) before starting, guaranteeing a single in-flight writer even under
 * concurrent async callers.
 */
export class WriterQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Enqueue a job to run after all previously enqueued jobs have settled.
   *
   * @typeParam T - The job's result type.
   * @param job - The unit of work; may be synchronous or asynchronous.
   * @returns A promise for the job's result.
   */
  public enqueue<T>(job: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => job());
    // Keep the chain alive regardless of this job's outcome so a rejection does
    // not wedge the queue for subsequent writers.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
