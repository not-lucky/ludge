/**
 * SQLite transaction-only execution writer.
 *
 * Instances are constructed only by {@link SqliteUnitOfWork}, binding inserts to
 * its writer connection and therefore to the enclosing transaction.
 */

import type { ExecutionWriter } from "../../ports/index.js";
import type { SqliteConnection } from "../connection.js";
import { insertObject } from "../row-io.js";
import type { ExecutionRow, SqlitePersistenceRecords } from "../rows.js";

/** Writes execution rows through one SQLite transaction connection. */
export class SqliteExecutionRepository
  implements ExecutionWriter<SqlitePersistenceRecords>
{
  public constructor(private readonly db: SqliteConnection) {}

  /** Commit an execution row. Durable only when the transaction commits. */
  public commit(execution: ExecutionRow): Promise<void> {
    insertObject(this.db, "execution", execution);
    return Promise.resolve();
  }
}
