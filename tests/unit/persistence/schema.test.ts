/**
 * Unit tests for the current schema application and its enforced invariants.
 *
 * These drive a real, migrated database (via {@link createRawDb}) and assert the
 * structural guarantees the mappers and repositories rely on: the full table
 * surface exists and `user_version` is stamped, the `execution` and
 * `benchmark_sample` uniqueness rules hold, the `benchmark_comparability` ↔ reason
 * CHECK rejects illegal combinations, and foreign keys cascade (run children) vs
 * restrict (referenced problems) as specified.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../src/persistence/sqlite/schema.js";
import { insertObject } from "../../../src/persistence/sqlite/row-io.js";
import { runToRow } from "../../../src/persistence/sqlite/mappers.js";
import type { RawDb } from "../../fixtures/persistence/index.js";
import {
  createRawDb,
  makeExecution,
  makeRun,
  makeSample,
  seedGraphOn,
} from "../../fixtures/persistence/index.js";

describe("schema application", () => {
  let raw: RawDb;

  beforeEach(() => {
    raw = createRawDb();
  });

  afterEach(() => {
    raw.cleanup();
  });

  it("creates all current tables and stamps the schema version", () => {
    const tables = raw.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master " +
          "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get();
    expect(Number(tables?.["n"])).toBe(11);

    const version = raw.db.prepare("PRAGMA user_version").get();
    expect(Number(version?.["user_version"])).toBe(SCHEMA_VERSION);
  });

  it("includes benchmark plan provenance on runs", () => {
    const columns = raw.db.prepare("PRAGMA table_info(run)").all();
    expect(columns.map((column) => column["name"])).toContain(
      "benchmark_plan_sha256",
    );
  });

  it("enforces UNIQUE(case_id, implementation_id) on execution", () => {
    seedGraphOn(raw.db);
    insertObject(raw.db, "execution", makeExecution());
    expect(() =>
      insertObject(
        raw.db,
        "execution",
        makeExecution({ execution_id: "exec-0002" }),
      ),
    ).toThrow();
  });

  it("enforces UNIQUE(run,case,impl,ordinal) on benchmark_sample", () => {
    seedGraphOn(raw.db);
    insertObject(raw.db, "benchmark_sample", makeSample());
    expect(() =>
      insertObject(
        raw.db,
        "benchmark_sample",
        makeSample({ sample_id: "sample-0002" }),
      ),
    ).toThrow();
  });

  it("rejects a comparable run that also carries a reason", () => {
    const row = {
      ...runToRow(makeRun()),
      run_id: "run-check-1",
      benchmark_comparability: 1,
      benchmark_comparability_reason: "should-not-have-a-reason",
    };
    expect(() => insertObject(raw.db, "run", row)).toThrow();
  });

  it("rejects a non-comparable run missing its reason", () => {
    const row = {
      ...runToRow(makeRun()),
      run_id: "run-check-2",
      benchmark_comparability: 0,
      benchmark_comparability_reason: null,
    };
    expect(() => insertObject(raw.db, "run", row)).toThrow();
  });

  it("cascades deletes from run to its child cases", () => {
    seedGraphOn(raw.db);
    raw.db
      .prepare("DELETE FROM run WHERE run_id = :id")
      .run({ id: "run-0001" });
    const cases = raw.db.prepare('SELECT COUNT(*) AS n FROM "case"').get();
    expect(Number(cases?.["n"])).toBe(0);
  });

  it("restricts deleting a problem still referenced by an implementation", () => {
    seedGraphOn(raw.db);
    expect(() =>
      raw.db
        .prepare("DELETE FROM problem WHERE problem_id = :id")
        .run({ id: "prob-0001" }),
    ).toThrow();
  });
});
