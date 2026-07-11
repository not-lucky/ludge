/**
 * SQLite {@link MetricsRepository} implementation.
 *
 * `upsertDaily` keeps a single row per `(metric_date, problem_id)` so repeated
 * rollups are idempotent: an `INSERT … ON CONFLICT DO UPDATE` overwrites the
 * counters and timestamps in place. Writes are durable only within a transaction;
 * `list` streams every stored day from a read-only connection.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { MetricsRepository } from "../../ports/index.js";
import type { SqliteConnection } from "../connection.js";
import { readMetricRow } from "../row-io.js";
import type { DailyMetricRow, SqlitePersistenceRecords } from "../rows.js";

/** Upsert that overwrites the counters and `solved_at` on the composite PK. */
const UPSERT_DAILY_SQL = [
  "INSERT INTO daily_metric",
  "  (metric_date, problem_id, attempts, passes, failures, wall_ns, solved_at)",
  "VALUES",
  "  (:metric_date, :problem_id, :attempts, :passes, :failures, :wall_ns, :solved_at)",
  "ON CONFLICT(metric_date, problem_id) DO UPDATE SET",
  "  attempts = excluded.attempts,",
  "  passes = excluded.passes,",
  "  failures = excluded.failures,",
  "  wall_ns = excluded.wall_ns,",
  "  solved_at = excluded.solved_at",
].join("\n");

/** A {@link MetricsRepository} backed by a single SQLite connection. */
export class SqliteMetricsRepository
  implements MetricsRepository<SqlitePersistenceRecords>
{
  /**
   * @param db - The bound connection (writer inside a transaction, else reader).
   */
  public constructor(private readonly db: SqliteConnection) {}

  /**
   * Insert or update the metric row for a day. Durable only within a
   * transaction.
   *
   * @param metric - The daily metric row to store.
   */
  public upsertDaily(metric: DailyMetricRow): Promise<void> {
    this.db.prepare(UPSERT_DAILY_SQL).run({
      metric_date: metric.metric_date,
      problem_id: metric.problem_id,
      attempts: metric.attempts,
      passes: metric.passes,
      failures: metric.failures,
      wall_ns: metric.wall_ns,
      solved_at: metric.solved_at,
    });
    return Promise.resolve();
  }

  /**
   * Stream every stored daily metric, most recent day first.
   *
   * @returns An async stream of metric rows.
   */
  public list(): AsyncIterable<DailyMetricRow> {
    const statement = this.db.prepare(
      "SELECT * FROM daily_metric ORDER BY metric_date DESC, problem_id ASC",
    );
    async function* stream(): AsyncGenerator<DailyMetricRow> {
      for (const raw of statement.iterate()) {
        yield readMetricRow(raw);
      }
    }
    return stream();
  }
}
