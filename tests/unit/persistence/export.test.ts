/**
 * Unit tests for the versioned JSON Lines export.
 *
 * The first line must be a self-describing header pinning the schema version and
 * value conventions; subsequent lines are table rows in dependency order. Every
 * 64-bit integer column is emitted as a decimal string (so precision survives
 * JSON's number), seeds stay canonical decimal text, and content hashes are
 * preserved verbatim.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPORT_FORMAT_VERSION,
  exportJsonl,
} from "../../../src/persistence/sqlite/export.js";
import { SCHEMA_VERSION } from "../../../src/persistence/sqlite/schema.js";
import { insertObject } from "../../../src/persistence/sqlite/row-io.js";
import { runToRow } from "../../../src/persistence/sqlite/mappers.js";
import type { RawDb } from "../../fixtures/persistence/index.js";
import { createRawDb, makeRun } from "../../fixtures/persistence/index.js";

/** Collect every emitted JSON Lines record from an export. */
function exportLines(raw: RawDb): unknown[] {
  const lines: string[] = [];
  exportJsonl(raw.db, (line) => lines.push(line));
  return lines.map((line) => JSON.parse(line) as unknown);
}

describe("exportJsonl", () => {
  let raw: RawDb;

  beforeEach(() => {
    raw = createRawDb();
  });

  afterEach(() => {
    raw.cleanup();
  });

  it("emits a self-describing header first", () => {
    const [header] = exportLines(raw) as Array<Record<string, unknown>>;
    expect(header?.["kind"]).toBe("header");
    expect(header?.["exportFormatVersion"]).toBe(EXPORT_FORMAT_VERSION);
    expect(header?.["schemaVersion"]).toBe(SCHEMA_VERSION);
    const units = header?.["units"] as Record<string, unknown>;
    expect(units["durations"]).toBe("nanoseconds");
    expect(units["memory"]).toBe("bytes");
    expect(String(header?.["nullSemantics"])).toContain("unavailable");
  });

  it("preserves hashes verbatim, seeds as text, and 64-bit ints as decimal strings", () => {
    insertObject(raw.db, "run", runToRow(makeRun({ seed: "42" })));

    const rows = exportLines(raw).slice(1) as Array<Record<string, unknown>>;
    const runLine = rows.find((r) => r["table"] === "run");
    expect(runLine).toBeDefined();

    const row = runLine?.["row"] as Record<string, unknown>;
    expect(row["seed"]).toBe("42");
    expect(row["input_hash"]).toBe("a".repeat(64));
    // generation and duration_ms are INTEGER columns, read as bigint and
    // serialized as decimal strings to avoid precision loss.
    expect(row["generation"]).toBe("0");
    expect(row["duration_ms"]).toBe("42");
  });
});
