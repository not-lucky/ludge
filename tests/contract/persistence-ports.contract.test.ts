/** Direct SQLite transaction and query behavior. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toRunId } from "../../src/domain/index.js";
import { TransactionAbortedError } from "../../src/persistence/sqlite/errors.js";
import {
  createTempStore,
  makeAggregate,
  makeCase,
  makeExecution,
  makeImplementation,
  makeMetric,
  makeProblem,
  makeRun,
  makeSample,
  seedRunGraph,
} from "../fixtures/persistence/index.js";
import type { TempStore } from "../fixtures/persistence/index.js";

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

describe("SQLite run queries", () => {
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
      await uow.runs.commit(
        makeRun({ runId: toRunId("run-a"), slug: "two-sum" }),
      );
      await uow.runs.commit(
        makeRun({ runId: toRunId("run-b"), slug: "other" }),
      );
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

describe("SQLite problem queries", () => {
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

describe("SQLite benchmark queries", () => {
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

describe("SQLite metric queries", () => {
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

describe("SQLite transactions", () => {
  it("does not leak transaction-only writers through the read store", () => {
    expect(temp.store).not.toHaveProperty("implementations");
    expect(temp.store).not.toHaveProperty("cases");
    expect(temp.store).not.toHaveProperty("executions");
    expect(temp.store).not.toHaveProperty("artifacts");
  });

  it("exposes transaction-only writers that commit the complete test run graph", async () => {
    const problem = makeProblem();
    const implementation = makeImplementation();
    const run = makeRun();
    const caseRecord = makeCase();
    const execution = makeExecution();
    const artifact = {
      artifact_id: "artifact-0001",
      run_id: "run-0001",
      kind: "mismatch",
      path: ".palestra/artifacts/artifact-0001.json",
      sha256: "e".repeat(64),
      size_bytes: 42n,
      created_at: "2026-07-20T00:00:00.000Z",
    };

    await temp.store.transaction.transact(async (uow) => {
      await uow.problems.register(problem);
      await uow.implementations.register(implementation);
      await uow.runs.commit(run);
      await uow.cases.commit(caseRecord);
      await uow.executions.commit(execution);
      await uow.artifacts.commit(artifact);
    });

    const lines: string[] = [];
    temp.store.export((line) => lines.push(line));
    expect(lines.join("\n")).toContain('"implementation_id":"impl-0001"');
    expect(lines.join("\n")).toContain('"case_id":"case-0001"');
    expect(lines.join("\n")).toContain('"execution_id":"exec-0001"');
    expect(lines.join("\n")).toContain('"artifact_id":"artifact-0001"');
  });

  it("rolls back transaction-only writer inserts with their parents", async () => {
    const problem = makeProblem();
    const implementation = makeImplementation();
    const run = makeRun();
    const caseRecord = makeCase();

    await expect(
      temp.store.transaction.transact(async (uow) => {
        await uow.problems.register(problem);
        await uow.implementations.register(implementation);
        await uow.runs.commit(run);
        await uow.cases.commit(caseRecord);
        throw new Error("boom");
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);

    const lines: string[] = [];
    temp.store.export((line) => lines.push(line));
    expect(lines).toHaveLength(1); // Export metadata only; no persisted rows.
    expect(lines.join("\n")).not.toContain('"run-0001"');
  });

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
