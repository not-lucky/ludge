/**
 * SQLite {@link BenchmarkRepository} implementation.
 *
 * Samples and the run's aggregate are written through the transaction-scoped
 * writer so they commit atomically with the owning run; the read accessors stream
 * samples and fetch the single aggregate from a read-only connection. Samples are
 * streamed in `ordinal` order so a consumer sees the measurement series in the
 * sequence it was produced.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { RunId } from "../../../domain/index.js";
import type { SqliteConnection } from "../connection.js";
import { insertObject, readAggregateRow, readSampleRow } from "../row-io.js";
import type { BenchmarkAggregateRow, BenchmarkSampleRow } from "../rows.js";

/** A {@link BenchmarkRepository} backed by a single SQLite connection. */
export class SqliteBenchmarkRepository {
  /**
   * @param db - The bound connection (writer inside a transaction, else reader).
   */
  public constructor(private readonly db: SqliteConnection) {}

  /**
   * Persist one benchmark sample. Durable only within a transaction.
   *
   * @param sample - The per-sample benchmark row to store.
   */
  public commitSample(sample: BenchmarkSampleRow): Promise<void> {
    insertObject(this.db, "benchmark_sample", sample);
    return Promise.resolve();
  }

  /**
   * Persist a benchmark aggregate. Durable only within a transaction.
   *
   * @param aggregate - The aggregated benchmark row to store.
   */
  public commitAggregate(aggregate: BenchmarkAggregateRow): Promise<void> {
    insertObject(this.db, "benchmark_aggregate", aggregate);
    return Promise.resolve();
  }

  /**
   * Stream all samples recorded for a run, in measurement order.
   *
   * @param runId - The run whose samples to stream.
   * @returns An async stream of sample rows.
   */
  public listSamples(runId: RunId): AsyncIterable<BenchmarkSampleRow> {
    const statement = this.db.prepare(
      "SELECT * FROM benchmark_sample WHERE run_id = :run_id ORDER BY ordinal ASC, sample_id ASC",
    );
    async function* stream(): AsyncGenerator<BenchmarkSampleRow> {
      for (const raw of statement.iterate({ run_id: runId })) {
        yield readSampleRow(raw);
      }
    }
    return stream();
  }

  /**
   * Look up the aggregate recorded for a run.
   *
   * @param runId - The run whose aggregate to fetch.
   * @returns The stored aggregate, or `null` when none exists.
   */
  public findAggregate(runId: RunId): Promise<BenchmarkAggregateRow | null> {
    const raw = this.db
      .prepare("SELECT * FROM benchmark_aggregate WHERE run_id = :run_id")
      .get({ run_id: runId });
    return Promise.resolve(raw === undefined ? null : readAggregateRow(raw));
  }
}
