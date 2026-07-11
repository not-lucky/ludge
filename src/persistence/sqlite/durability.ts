/**
 * Durability configuration for a SQLite connection.
 *
 * The store's durability contract (see `docs/storage/sqlite-metrics.md`) is
 * fixed: Write-Ahead Logging, `synchronous = NORMAL`, foreign keys enforced,
 * and a `2000 ms` busy timeout. WAL is local-filesystem only, so if the driver
 * refuses to enter WAL mode (for example on a network share or an in-memory
 * database) this is a hard {@link DurabilityConfigError} — the adapter never
 * silently downgrades to a weaker journal mode, because that would quietly
 * change the durability semantics the run history relies on.
 *
 * This is an adapter module; it manipulates a {@link SqliteConnection} but
 * imports the driver only as a type.
 */

import type { SqliteConnection } from "./connection.js";
import { DurabilityConfigError } from "./errors.js";

/**
 * The persistence-mode label recorded in the environment record.
 *
 * Identifies the configured durability regime so a report can tell that a run
 * was measured under local WAL persistence (a change here makes benchmark
 * environments non-comparable, since it feeds the host fingerprint).
 */
export const DATABASE_MODE = "sqlite-wal-local";

/** The busy timeout applied to every connection, in milliseconds. */
export const BUSY_TIMEOUT_MS = 2000;

/** Whether a connection is configured for writing or read-only access. */
export type DurabilityRole = "read-write" | "read-only";

/** Read a scalar column from a one-row PRAGMA result. */
function pragmaScalar(
  db: SqliteConnection,
  pragma: string,
  column: string,
): string | number | bigint | null | undefined {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row?.[column] as string | number | bigint | null | undefined;
}

/**
 * Apply the durability pragmas to a connection.
 *
 * A read-write connection asserts that WAL journaling actually took effect; a
 * read-only connection additionally sets `query_only` so a stray write is
 * rejected by the engine rather than only by convention. Foreign keys and the
 * busy timeout are applied to both.
 *
 * @param db - The connection to configure.
 * @param role - Whether the connection may write.
 * @throws {DurabilityConfigError} If WAL cannot be enabled on a writer.
 */
export function configureConnection(
  db: SqliteConnection,
  role: DurabilityRole,
): void {
  // Foreign keys and busy timeout apply to every connection.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  if (role === "read-only") {
    db.exec("PRAGMA query_only = ON");
    return;
  }

  // Writers must run in WAL; refuse to proceed if the engine downgraded it.
  const journalMode = pragmaScalar(db, "journal_mode = WAL", "journal_mode");
  if (journalMode !== "wal") {
    throw new DurabilityConfigError(
      `WAL journaling is unavailable (journal_mode = ${String(journalMode)}); ` +
        `the database must live on a local filesystem that supports WAL`,
    );
  }
  db.exec("PRAGMA synchronous = NORMAL");
}
