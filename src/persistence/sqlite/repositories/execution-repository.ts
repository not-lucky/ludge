/**
 * SQLite transaction-only execution writer.
 *
 * Instances are constructed only by {@link SqliteUnitOfWork}, binding inserts to
 * its writer connection and therefore to the enclosing transaction.
 */

import type { SqliteConnection } from "../connection.js";
import { insertObject } from "../row-io.js";
import type { ExecutionRow } from "../rows.js";

/** Writes execution rows through one SQLite transaction connection. */
export class SqliteExecutionRepository {
  public constructor(private readonly db: SqliteConnection) {}

  /** Commit an execution row. Durable only when the transaction commits. */
  public commit(execution: ExecutionRow): Promise<void> {
    insertObject(this.db, "execution", execution);
    return Promise.resolve();
  }
}
