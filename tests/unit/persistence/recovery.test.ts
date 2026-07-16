/**
 * Unit tests for startup integrity verification and orphaned-run recovery.
 *
 * A run left non-terminal with no active child execution is cancelled; a run with
 * a still-active child is left untouched; referenced rows (artifacts) are always
 * retained. A connection whose `integrity_check` reports corruption is refused
 * with an {@link IntegrityCheckError} before any recovery UPDATE runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SqliteConnection,
  SqliteStatement,
} from "../../../src/persistence/sqlite/connection.js";
import { IntegrityCheckError } from "../../../src/persistence/sqlite/errors.js";
import { runStartupRecovery } from "../../../src/persistence/sqlite/recovery.js";
import { insertObject } from "../../../src/persistence/sqlite/row-io.js";
import { runToRow } from "../../../src/persistence/sqlite/mappers.js";
import type { RawDb } from "../../fixtures/persistence/index.js";
import {
  createRawDb,
  makeCase,
  makeExecution,
  makeImplementation,
  makeProblem,
  makeRun,
} from "../../fixtures/persistence/index.js";

/** Insert a run row with an arbitrary (possibly non-terminal) lifecycle state. */
function insertRun(raw: RawDb, runId: string, state: string): void {
  insertObject(raw.db, "run", {
    ...runToRow(makeRun()),
    run_id: runId,
    state,
    status: state,
  });
}

describe("runStartupRecovery", () => {
  let raw: RawDb;

  beforeEach(() => {
    raw = createRawDb();
  });

  afterEach(() => {
    raw.cleanup();
  });

  it("cancels an interrupted run with no active child", () => {
    insertRun(raw, "run-orphan", "running");

    const report = runStartupRecovery(raw.db);

    expect(report.canceledRuns).toBe(1);
    const row = raw.db
      .prepare("SELECT state, status FROM run WHERE run_id = :id")
      .get({ id: "run-orphan" });
    expect(row?.["state"]).toBe("canceled");
    expect(row?.["status"]).toBe("canceled");
  });

  it("leaves a non-terminal run whose child execution is still active", () => {
    insertObject(raw.db, "problem", makeProblem());
    insertObject(raw.db, "implementation", makeImplementation());
    insertRun(raw, "run-active", "running");
    insertObject(
      raw.db,
      "case",
      makeCase({ case_id: "case-active", run_id: "run-active" }),
    );
    insertObject(
      raw.db,
      "execution",
      makeExecution({
        execution_id: "exec-active",
        case_id: "case-active",
        status: "running",
      }),
    );

    const report = runStartupRecovery(raw.db);

    expect(report.canceledRuns).toBe(0);
    const row = raw.db
      .prepare("SELECT state FROM run WHERE run_id = :id")
      .get({ id: "run-active" });
    expect(row?.["state"]).toBe("running");
  });

  it("leaves already-terminal runs unchanged", () => {
    insertRun(raw, "run-done", "completed");
    const report = runStartupRecovery(raw.db);
    expect(report.canceledRuns).toBe(0);
  });

  it("retains artifacts while cancelling their interrupted run", () => {
    insertRun(raw, "run-art", "running");
    insertObject(raw.db, "artifact", {
      artifact_id: "art-1",
      run_id: "run-art",
      kind: "mismatch",
      path: "artifacts/art-1.bin",
      sha256: "e".repeat(64),
      size_bytes: 10n,
      created_at: "2026-07-20T00:00:00.000Z",
    });

    runStartupRecovery(raw.db);

    const artifacts = raw.db
      .prepare("SELECT COUNT(*) AS n FROM artifact")
      .get();
    expect(Number(artifacts?.["n"])).toBe(1);
  });

  it("refuses a corrupt database reported by integrity_check", () => {
    const statementFor = (sql: string): SqliteStatement => ({
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () =>
        sql.includes("integrity_check")
          ? [{ integrity_check: "malformed database schema" }]
          : [],
      iterate: () => [][Symbol.iterator](),
    });
    const fake: SqliteConnection = {
      path: ":fake:",
      exec: () => undefined,
      prepare: (sql: string) => statementFor(sql),
      close: () => undefined,
    };

    expect(() => runStartupRecovery(fake)).toThrow(IntegrityCheckError);
  });
});
