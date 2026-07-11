/**
 * Contract tests for the persistence ports, driven by the real SQLite adapter.
 *
 * Each suite pins an obligation any concrete implementation must satisfy and
 * exercises it against a temp-file {@link SqliteStore} instantiated at
 * {@link SqlitePersistenceRecords}: round-trips, query filtering, ordinal
 * ordering, upsert idempotence, and transactional atomicity. Writes go through
 * the transaction seam; reads go through the store's read-only accessors.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRunId } from "../../src/domain/index.js";
import type {
  BenchmarkRepository,
  MetricsRepository,
  PersistenceRecords,
  ProblemRepository,
  RunRepository,
  TransactionScope,
  UnitOfWork,
} from "../../src/persistence/ports/index.js";
import { TransactionAbortedError } from "../../src/persistence/sqlite/index.js";
import {
  createTempStore,
  makeAggregate,
  makeMetric,
  makeProblem,
  makeRun,
  makeSample,
  seedRunGraph,
} from "../fixtures/persistence/index.js";
import type { TempStore } from "../fixtures/persistence/index.js";

// Retain the type-only imports and verify the port surface exists.
type _PortSurface = [
  BenchmarkRepository<PersistenceRecords>,
  MetricsRepository<PersistenceRecords>,
  ProblemRepository<PersistenceRecords>,
  RunRepository,
  TransactionScope<PersistenceRecords>,
  UnitOfWork<PersistenceRecords>,
];

/** Drain an async iterable into an array. */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

let temp: TempStore;

beforeEach(() => {
  temp = createTempStore();
});

afterEach(() => {
  temp.cleanup();
});

describe("RunRepository contract", () => {
  it("commit() then findById() returns the identical persisted run", async () => {
    const run = makeRun({ seed: "42" });
    await temp.store.transaction.transact((uow) => uow.runs.commit(run));

    const fetched = await temp.store.runs.findById(run.runId);
    expect(fetched).toEqual(run);
  });

  it("findById() returns null for an unknown run id", async () => {
    const run = makeRun();
    expect(await temp.store.runs.findById(run.runId)).toBeNull();
  });

  it("list() streams matching runs and applies the query filters", async () => {
    await temp.store.transaction.transact(async (uow) => {
      await uow.runs.commit(makeRun({ runId: toRunId("run-a"), slug: "two-sum" }));
      await uow.runs.commit(makeRun({ runId: toRunId("run-b"), slug: "other" }));
    });

    const bySlug = await collect(temp.store.runs.list({ slug: "two-sum" }));
    expect(bySlug.map((r) => r.slug)).toEqual(["two-sum"]);

    const all = await collect(temp.store.runs.list({}));
    expect(all).toHaveLength(2);

    const limited = await collect(temp.store.runs.list({ limit: 1 }));
    expect(limited).toHaveLength(1);
  });

  it("read accessors cannot write (reads use a read-only connection)", () => {
    expect(() => temp.store.runs.commit(makeRun())).toThrow();
  });
});

describe("ProblemRepository contract", () => {
  it("register() then findBySlug() returns the registered problem", async () => {
    const problem = makeProblem();
    await temp.store.transaction.transact((uow) =>
      uow.problems.register(problem),
    );

    expect(await temp.store.problems.findBySlug(problem.slug)).toEqual(problem);
  });

  it("findBySlug() returns null for an unknown slug", async () => {
    expect(await temp.store.problems.findBySlug("nope")).toBeNull();
  });
});

describe("BenchmarkRepository contract", () => {
  beforeEach(() => {
    seedRunGraph(temp.path);
  });

  it("commitSample()/listSamples() preserve ordinal ordering", async () => {
    await temp.store.transaction.transact(async (uow) => {
      await uow.benchmarks.commitSample(
        makeSample({ sample_id: "s-1", ordinal: 1 }),
      );
      await uow.benchmarks.commitSample(
        makeSample({ sample_id: "s-0", ordinal: 0 }),
      );
    });

    const samples = await collect(
      temp.store.benchmarks.listSamples(makeRun().runId),
    );
    expect(samples.map((s) => s.ordinal)).toEqual([0, 1]);
  });

  it("commitAggregate()/findAggregate() round-trip aggregate statistics", async () => {
    const aggregate = makeAggregate();
    await temp.store.transaction.transact((uow) =>
      uow.benchmarks.commitAggregate(aggregate),
    );

    expect(await temp.store.benchmarks.findAggregate(makeRun().runId)).toEqual(
      aggregate,
    );
  });
});

describe("MetricsRepository contract", () => {
  beforeEach(async () => {
    await temp.store.transaction.transact((uow) =>
      uow.problems.register(makeProblem()),
    );
  });

  it("upsertDaily() is idempotent for the same day key", async () => {
    await temp.store.transaction.transact((uow) =>
      uow.metrics.upsertDaily(makeMetric({ attempts: 1, passes: 1 })),
    );
    await temp.store.transaction.transact((uow) =>
      uow.metrics.upsertDaily(makeMetric({ attempts: 3, passes: 2 })),
    );

    const metrics = await collect(temp.store.metrics.list());
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.attempts).toBe(3);
    expect(metrics[0]?.passes).toBe(2);
  });
});

describe("TransactionScope contract", () => {
  it("transact() commits run + child records atomically on success", async () => {
    const problem = makeProblem();
    const run = makeRun();
    await temp.store.transaction.transact(async (uow) => {
      await uow.problems.register(problem);
      await uow.runs.commit(run);
    });

    expect(await temp.store.problems.findBySlug(problem.slug)).toEqual(problem);
    expect(await temp.store.runs.findById(run.runId)).toEqual(run);
  });

  it("transact() rolls back ALL writes when the callback throws", async () => {
    const problem = makeProblem();
    const run = makeRun();
    await expect(
      temp.store.transaction.transact(async (uow) => {
        await uow.problems.register(problem);
        await uow.runs.commit(run);
        throw new Error("boom");
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);

    expect(await temp.store.problems.findBySlug(problem.slug)).toBeNull();
    expect(await temp.store.runs.findById(run.runId)).toBeNull();
  });

  it("transact() surfaces the callback's return value", async () => {
    const value = await temp.store.transaction.transact(() =>
      Promise.resolve(99),
    );
    expect(value).toBe(99);
  });
});
