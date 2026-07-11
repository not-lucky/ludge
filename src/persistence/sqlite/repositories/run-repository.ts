/**
 * SQLite {@link RunRepository} implementation.
 *
 * A repository instance is bound to one connection. In a transaction it is
 * handed the writer connection, so `commit` participates in the enclosing atomic
 * unit; as a store read accessor it is bound to a read-only connection, where
 * `commit` would be rejected by the engine's `query_only` guard. Reads stream
 * rows through an `AsyncIterable` so an unbounded history is never fully
 * buffered.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { PersistableRun, RunId, RunQuery } from "../../../domain/index.js";
import type { RunRepository } from "../../ports/index.js";
import type { SqliteConnection } from "../connection.js";
import {
  buildRunWhere,
  readRunRow,
  rowToRun,
  runInsert,
  runToRow,
} from "../mappers.js";

/** A {@link RunRepository} backed by a single SQLite connection. */
export class SqliteRunRepository implements RunRepository {
  /**
   * @param db - The bound connection (writer inside a transaction, else reader).
   */
  public constructor(private readonly db: SqliteConnection) {}

  /**
   * Persist a completed run snapshot. Durable only within a transaction.
   *
   * @param run - The immutable run Memento to store.
   */
  public commit(run: PersistableRun): Promise<void> {
    const { sql, params } = runInsert(runToRow(run));
    this.db.prepare(sql).run(params);
    return Promise.resolve();
  }

  /**
   * Look up a single run by identity.
   *
   * @param runId - The run to fetch.
   * @returns The stored run, or `null` when none matches.
   */
  public findById(runId: RunId): Promise<PersistableRun | null> {
    const raw = this.db
      .prepare("SELECT * FROM run WHERE run_id = :run_id")
      .get({ run_id: runId });
    return Promise.resolve(raw === undefined ? null : rowToRun(readRunRow(raw)));
  }

  /**
   * Stream stored runs matching a query, newest first.
   *
   * @param query - Filters to apply; absent fields impose no filter.
   * @returns An async stream of matching runs.
   */
  public list(query: RunQuery): AsyncIterable<PersistableRun> {
    const { sql, params } = buildRunWhere(query);
    const statement = this.db.prepare(`SELECT * FROM run${sql}`);
    async function* stream(): AsyncGenerator<PersistableRun> {
      for (const raw of statement.iterate(params)) {
        yield rowToRun(readRunRow(raw));
      }
    }
    return stream();
  }
}
