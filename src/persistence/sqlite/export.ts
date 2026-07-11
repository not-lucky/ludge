/**
 * Versioned JSON Lines export of the entire store.
 *
 * {@link exportJsonl} streams the database as newline-delimited JSON: a single
 * self-describing header line followed by one line per row, each tagged with its
 * table. The header pins the `schemaVersion` and spells out the value conventions
 * a reader needs — durations and byte counts are nanoseconds/bytes, 64-bit
 * integers are emitted as decimal *strings* so no precision is lost crossing
 * JSON's `number`, `null` means unavailable (never a measured zero), seeds stay
 * canonical decimal text, and content hashes are preserved verbatim. The export
 * is read-only: it opens no transaction and mutates nothing.
 *
 * This is an adapter module; it manipulates a {@link SqliteConnection} but
 * imports the driver only as a type.
 */

import type { SqliteConnection, SqlOutputValue } from "./connection.js";
import { DATABASE_MODE } from "./durability.js";
import { quoteTable } from "./row-io.js";
import { SCHEMA_VERSION, TABLE_NAMES } from "./schema.js";

/** The export format version, independent of the database schema version. */
export const EXPORT_FORMAT_VERSION = 1;

/** A destination for export lines (one call per JSON Lines record). */
export type JsonlSink = (line: string) => void;

/** Convert a column value into a JSON-safe form, preserving 64-bit precision. */
function encodeValue(value: SqlOutputValue): string | number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    // Decimal string: a 64-bit integer would lose precision as a JSON number.
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  return value;
}

/** Encode one raw row into a JSON-safe object. */
function encodeRow(
  raw: Record<string, SqlOutputValue>,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = encodeValue(value);
  }
  return out;
}

/**
 * Export the whole database as JSON Lines to `sink`.
 *
 * The first emitted line is the header; the remaining lines are table rows in
 * dependency order (parents before children), each tagged with its `table`.
 *
 * @param db - The connection to read from (a read-only connection is expected).
 * @param sink - Receives each JSON Lines record, without a trailing newline.
 */
export function exportJsonl(db: SqliteConnection, sink: JsonlSink): void {
  const header = {
    kind: "header",
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    databaseMode: DATABASE_MODE,
    units: {
      durations: "nanoseconds",
      memory: "bytes",
      timestamps: "utc-iso-8601",
    },
    encoding: {
      integers64: "decimal-string",
      seeds: "unsigned-64 canonical decimal string",
      contentHashes: "lowercase sha-256 hex, preserved verbatim",
    },
    nullSemantics: "null = unavailable/not-applicable; 0 = measured zero",
  };
  sink(JSON.stringify(header));

  for (const table of TABLE_NAMES) {
    const statement = db.prepare(`SELECT * FROM ${quoteTable(table)}`);
    for (const raw of statement.iterate()) {
      sink(JSON.stringify({ kind: "row", table, row: encodeRow(raw) }));
    }
  }
}
