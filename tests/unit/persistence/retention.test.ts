/**
 * Unit tests for the raw-payload retention pass.
 *
 * With an injected `now`, executions and benchmark samples on runs older than the
 * 30-day window have their `raw_json` nulled (row and metrics kept); rows on
 * recent runs are untouched; aggregates and artifacts are never pruned.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRetention } from "../../../src/persistence/sqlite/retention.js";
import { insertObject } from "../../../src/persistence/sqlite/row-io.js";
import type { RawDb } from "../../fixtures/persistence/index.js";
import {
  createRawDb,
  makeAggregate,
  makeExecution,
  makeSample,
  seedGraphOn,
} from "../../fixtures/persistence/index.js";

describe("applyRetention", () => {
  let raw: RawDb;

  beforeEach(() => {
    // seedGraphOn creates run-0001 started_at 2026-07-20 plus its case.
    raw = createRawDb();
    seedGraphOn(raw.db);
    insertObject(raw.db, "execution", makeExecution());
    insertObject(
      raw.db,
      "benchmark_sample",
      makeSample({ raw_json: '{"s":1}' }),
    );
  });

  afterEach(() => {
    raw.cleanup();
  });

  it("prunes raw payloads on runs older than the retention window", () => {
    const report = applyRetention(raw.db, new Date("2026-09-01T00:00:00.000Z"));

    expect(report.executionsPruned).toBe(1);
    expect(report.samplesPruned).toBe(1);

    const execution = raw.db
      .prepare("SELECT raw_json FROM execution WHERE execution_id = :id")
      .get({ id: "exec-0001" });
    expect(execution?.["raw_json"]).toBeNull();

    const sample = raw.db
      .prepare("SELECT raw_json FROM benchmark_sample WHERE sample_id = :id")
      .get({ id: "sample-0001" });
    expect(sample?.["raw_json"]).toBeNull();
  });

  it("preserves raw payloads on runs inside the retention window", () => {
    const report = applyRetention(raw.db, new Date("2026-07-20T12:00:00.000Z"));

    expect(report.executionsPruned).toBe(0);
    expect(report.samplesPruned).toBe(0);

    const execution = raw.db
      .prepare("SELECT raw_json FROM execution WHERE execution_id = :id")
      .get({ id: "exec-0001" });
    expect(execution?.["raw_json"]).toBe('{"v":1}');
  });

  it("never prunes aggregates or artifacts", () => {
    insertObject(raw.db, "benchmark_aggregate", makeAggregate());
    insertObject(raw.db, "artifact", {
      artifact_id: "art-1",
      run_id: "run-0001",
      kind: "mismatch",
      path: "artifacts/art-1.bin",
      sha256: "e".repeat(64),
      size_bytes: 10n,
      created_at: "2026-07-20T00:00:00.000Z",
    });

    applyRetention(raw.db, new Date("2026-09-01T00:00:00.000Z"));

    const aggregates = raw.db
      .prepare("SELECT COUNT(*) AS n FROM benchmark_aggregate")
      .get();
    const artifacts = raw.db
      .prepare("SELECT COUNT(*) AS n FROM artifact")
      .get();
    expect(Number(aggregates?.["n"])).toBe(1);
    expect(Number(artifacts?.["n"])).toBe(1);
  });
});
