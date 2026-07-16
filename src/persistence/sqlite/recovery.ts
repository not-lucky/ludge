/**
 * Startup integrity verification and orphaned-run recovery.
 *
 * A store may reopen after a crash mid-run. {@link runStartupRecovery} first
 * verifies the file is sound (`PRAGMA integrity_check` and `foreign_key_check`);
 * a corrupt or dangling database is refused with an {@link IntegrityCheckError}
 * rather than opened and further damaged. It then marks any run left in a
 * non-terminal lifecycle state as `canceled` — but only once it has confirmed no
 * child execution is still active, so a run whose worker is genuinely mid-flight
 * is never clobbered. Artifacts are always retained: recovery only rewrites run
 * lifecycle state, never deletes referenced rows.
 *
 * This is an adapter module; it manipulates a {@link SqliteConnection} but
 * imports the driver only as a type.
 */

import type { SqliteConnection } from "./connection.js";
import { IntegrityCheckError } from "./errors.js";

/**
 * Terminal run lifecycle states. A run in any other state when the store opens
 * was interrupted and is a candidate for cancellation.
 */
const TERMINAL_RUN_STATES: readonly string[] = [
  "completed",
  "failed",
  "canceled",
];

/**
 * The complete set of terminal execution verdicts. An execution whose status is
 * outside this set is treated as still active, so its owning run is left alone.
 */
const TERMINAL_EXECUTION_STATUSES: readonly string[] = [
  "passed",
  "wrong_answer",
  "nonzero_exit",
  "signaled",
  "tle_wall",
  "tle_cpu",
  "mle",
  "output_limit",
  "file_limit",
  "process_limit",
  "protocol_error",
  "invalid_input",
  "spawn_error",
  "sandbox_unsupported",
  "sandbox_error",
  "canceled",
  "internal_error",
];

/** The outcome of a startup recovery pass. */
export interface RecoveryReport {
  /** How many interrupted runs were transitioned to `canceled`. */
  readonly canceledRuns: number;
}

/**
 * Build a parameterized `IN (...)` clause and its bound parameters from a fixed
 * constant list. The values are build-time constants (never user input), and
 * they are still bound rather than interpolated to keep every statement uniform.
 */
function inClause(
  prefix: string,
  values: readonly string[],
): { placeholders: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const names = values.map((value, index) => {
    const key = `${prefix}${String(index)}`;
    params[key] = value;
    return `:${key}`;
  });
  return { placeholders: names.join(", "), params };
}

/** Read the `PRAGMA integrity_check` result, returning any problems found. */
function integrityFailures(db: SqliteConnection): string[] {
  const rows = db.prepare("PRAGMA integrity_check").all();
  const failures: string[] = [];
  for (const row of rows) {
    const value = row["integrity_check"];
    if (typeof value === "string" && value !== "ok") {
      failures.push(`integrity_check: ${value}`);
    }
  }
  return failures;
}

/** Read the `PRAGMA foreign_key_check` result, returning any violations. */
function foreignKeyFailures(db: SqliteConnection): string[] {
  const rows = db.prepare("PRAGMA foreign_key_check").all();
  return rows.map((row) => {
    const table = String(row["table"] ?? "?");
    const rowid = String(row["rowid"] ?? "?");
    const parent = String(row["parent"] ?? "?");
    return `foreign_key_check: ${table} row ${rowid} -> ${parent}`;
  });
}

/**
 * Verify integrity and recover interrupted runs, once, at store open.
 *
 * @param db - The writer connection to recover on.
 * @returns A report of how many runs were canceled.
 * @throws {IntegrityCheckError} If integrity or foreign-key checks fail.
 */
export function runStartupRecovery(db: SqliteConnection): RecoveryReport {
  const failures = [...integrityFailures(db), ...foreignKeyFailures(db)];
  if (failures.length > 0) {
    throw new IntegrityCheckError(failures);
  }

  const terminalRun = inClause("rs", TERMINAL_RUN_STATES);
  const terminalExec = inClause("es", TERMINAL_EXECUTION_STATUSES);

  // Cancel every non-terminal run that has no still-active child execution.
  const sql = [
    "UPDATE run",
    "SET state = 'canceled', status = 'canceled'",
    `WHERE state NOT IN (${terminalRun.placeholders})`,
    "AND run_id NOT IN (",
    '  SELECT c.run_id FROM "case" c',
    "  JOIN execution e ON e.case_id = c.case_id",
    `  WHERE e.status NOT IN (${terminalExec.placeholders})`,
    ")",
  ].join("\n");

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db
      .prepare(sql)
      .run({ ...terminalRun.params, ...terminalExec.params });
    db.exec("COMMIT");
    return { canceledRuns: result.changes };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
