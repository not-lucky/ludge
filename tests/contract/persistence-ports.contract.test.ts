/**
 * Contract-test scaffold for the persistence ports.
 *
 * These suites enumerate the obligations any concrete {@link RunRepository},
 * {@link ProblemRepository}, {@link BenchmarkRepository},
 * {@link MetricsRepository}, and {@link TransactionScope} implementation must
 * satisfy. They are `todo` placeholders: task 09 (SQLite adapter) supplies the
 * fixtures that drive these obligations, including the concrete
 * {@link PersistenceRecords} instantiation.
 */

import { describe, it } from "vitest";
import type {
  BenchmarkRepository,
  MetricsRepository,
  PersistenceRecords,
  ProblemRepository,
  RunRepository,
  TransactionScope,
  UnitOfWork,
} from "../../src/persistence/ports/index.js";

// Retain the type-only imports and verify the port surface exists.
type _PortSurface = [
  BenchmarkRepository<PersistenceRecords>,
  MetricsRepository<PersistenceRecords>,
  ProblemRepository<PersistenceRecords>,
  RunRepository,
  TransactionScope<PersistenceRecords>,
  UnitOfWork<PersistenceRecords>,
];

describe("RunRepository contract", () => {
  it.todo("commit() then findById() returns the identical persisted run");
  it.todo("findById() returns null for an unknown run id");
  it.todo("list() streams matching runs and applies the query filters");
  it.todo("read methods perform no writes");
});

describe("ProblemRepository contract", () => {
  it.todo("register() then findBySlug() returns the registered problem");
  it.todo("findBySlug() returns null for an unknown slug");
});

describe("BenchmarkRepository contract", () => {
  it.todo("commitSample()/listSamples() preserve ordinal ordering");
  it.todo("commitAggregate()/findAggregate() round-trip aggregate statistics");
});

describe("MetricsRepository contract", () => {
  it.todo("upsertDaily() is idempotent for the same day key");
});

describe("TransactionScope contract", () => {
  it.todo("transact() commits run + child records atomically on success");
  it.todo("transact() rolls back ALL writes when the callback throws");
  it.todo("transact() surfaces the callback's return value");
});
