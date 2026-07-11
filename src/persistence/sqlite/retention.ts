/**
 * Retention: prune stale raw payloads while preserving durable history.
 *
 * The retention policy (see `docs/storage/sqlite-metrics.md` § Retention) keeps
 * *all* aggregate history and every artifact indefinitely — artifacts are removed
 * only by an explicit manual action, never by this pass — but the bulky,
 * versioned `raw_json` envelopes on executions and benchmark samples are pruned
 * once their owning run is older than the retention window. Pruning nulls the
 * payload column and keeps the row, so counts, statuses, and timings survive; only
 * the replayable blob is dropped.
 *
 * `now` is injected so the 30-day cutoff is deterministic under test.
 *
 * This is an adapter module; it manipulates a {@link SqliteConnection} but
 * imports the driver only as a type.
 */

import type { SqliteConnection } from "./connection.js";

/** The raw-payload retention window, in days. */
export const RAW_RETENTION_DAYS = 30;

/** The retention window in milliseconds. */
const RAW_RETENTION_MS = RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** The outcome of a retention pass. */
export interface RetentionReport {
  /** How many execution rows had their `raw_json` pruned to `NULL`. */
  readonly executionsPruned: number;
  /** How many benchmark-sample rows had their `raw_json` pruned to `NULL`. */
  readonly samplesPruned: number;
  /** The UTC ISO-8601 cutoff; rows on runs started before it were pruned. */
  readonly cutoff: string;
}

/**
 * Prune raw payloads older than the retention window.
 *
 * Aggregates and artifacts are intentionally left untouched: the policy keeps
 * them until a separate, explicit deletion. Only `raw_json` on executions and
 * benchmark samples belonging to runs started before the cutoff is nulled.
 *
 * @param db - The writer connection to prune on.
 * @param now - The current instant, injected for deterministic cutoffs.
 * @returns A report with the cutoff and how many rows were pruned.
 */
export function applyRetention(
  db: SqliteConnection,
  now: Date,
): RetentionReport {
  const cutoff = new Date(now.getTime() - RAW_RETENTION_MS).toISOString();

  const pruneExecutions = [
    "UPDATE execution SET raw_json = NULL",
    "WHERE raw_json IS NOT NULL",
    "AND case_id IN (",
    '  SELECT c.case_id FROM "case" c',
    "  JOIN run r ON r.run_id = c.run_id",
    "  WHERE r.started_at < :cutoff",
    ")",
  ].join("\n");

  const pruneSamples = [
    "UPDATE benchmark_sample SET raw_json = NULL",
    "WHERE raw_json IS NOT NULL",
    "AND run_id IN (SELECT run_id FROM run WHERE started_at < :cutoff)",
  ].join("\n");

  db.exec("BEGIN IMMEDIATE");
  try {
    const executionsPruned = db.prepare(pruneExecutions).run({ cutoff }).changes;
    const samplesPruned = db.prepare(pruneSamples).run({ cutoff }).changes;
    db.exec("COMMIT");
    return { executionsPruned, samplesPruned, cutoff };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
