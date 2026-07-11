/**
 * Unit tests for the single-writer queue and busy-retry backoff.
 *
 * {@link WriterQueue} must serialize concurrent async callers so at most one job
 * is ever in flight, preserving enqueue order even when jobs interleave awaits.
 * {@link withBusyRetry} must retry only transient `SQLITE_BUSY`/`SQLITE_LOCKED`
 * failures with bounded backoff (driven by an injected sleeper), rethrow other
 * errors immediately, and surface a {@link PersistenceBusyError} once exhausted.
 */

import { describe, expect, it } from "vitest";
import { PersistenceBusyError } from "../../../src/persistence/sqlite/errors.js";
import {
  DEFAULT_BUSY_RETRY,
  isBusyError,
  WriterQueue,
  withBusyRetry,
} from "../../../src/persistence/sqlite/writer-queue.js";

describe("WriterQueue", () => {
  it("runs jobs one at a time, in enqueue order", async () => {
    const queue = new WriterQueue();
    let running = 0;
    let maxConcurrent = 0;
    const finished: number[] = [];

    const job = (n: number) => async (): Promise<number> => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await Promise.resolve();
      await Promise.resolve();
      running -= 1;
      finished.push(n);
      return n;
    };

    const results = await Promise.all(
      [0, 1, 2, 3].map((n) => queue.enqueue(job(n))),
    );

    expect(results).toEqual([0, 1, 2, 3]);
    expect(finished).toEqual([0, 1, 2, 3]);
    expect(maxConcurrent).toBe(1);
  });

  it("keeps the chain alive after a rejected job", async () => {
    const queue = new WriterQueue();
    const rejected = queue.enqueue(() => {
      throw new Error("boom");
    });
    await expect(rejected).rejects.toThrow("boom");
    await expect(queue.enqueue(() => 7)).resolves.toBe(7);
  });
});

describe("isBusyError", () => {
  it("classifies busy/locked errcodes and messages", () => {
    expect(isBusyError({ errcode: 5 })).toBe(true);
    expect(isBusyError({ errcode: 6 })).toBe(true);
    expect(isBusyError({ message: "database is locked" })).toBe(true);
    expect(isBusyError({ errcode: 1 })).toBe(false);
    expect(isBusyError(new Error("syntax error"))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});

describe("withBusyRetry", () => {
  it("retries transient busy failures with bounded backoff then gives up", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };

    await expect(
      withBusyRetry(
        () => {
          throw { errcode: 5 };
        },
        { baseDelayMs: 5, factor: 2, maxDelayMs: 200, maxAttempts: 4 },
        sleep,
      ),
    ).rejects.toBeInstanceOf(PersistenceBusyError);

    expect(delays).toEqual([5, 10, 20]);
  });

  it("caps each delay at maxDelayMs", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };

    await expect(
      withBusyRetry(
        () => {
          throw { errcode: 5 };
        },
        { baseDelayMs: 100, factor: 10, maxDelayMs: 150, maxAttempts: 3 },
        sleep,
      ),
    ).rejects.toBeInstanceOf(PersistenceBusyError);

    expect(delays).toEqual([100, 150]);
  });

  it("resolves once a transient failure clears", async () => {
    let attempts = 0;
    const result = await withBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw { errcode: 6 };
        }
        return "ok";
      },
      DEFAULT_BUSY_RETRY,
      async () => undefined,
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("rethrows a non-busy error without retrying", async () => {
    let attempts = 0;
    await expect(
      withBusyRetry(
        () => {
          attempts += 1;
          throw new Error("syntax error near FROM");
        },
        DEFAULT_BUSY_RETRY,
        async () => undefined,
      ),
    ).rejects.toThrow("syntax error near FROM");
    expect(attempts).toBe(1);
  });
});
