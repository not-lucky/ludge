/**
 * SQLite transaction-only case writer.
 *
 * Instances are constructed only by {@link SqliteUnitOfWork}, binding inserts to
 * its writer connection and therefore to the enclosing transaction.
 */

import type { SqliteConnection } from "../connection.js";
import { insertObject } from "../row-io.js";
import type { CaseRow } from "../rows.js";

/** Writes case rows through one SQLite transaction connection. */
export class SqliteCaseRepository {
  public constructor(private readonly db: SqliteConnection) {}

  /** Commit a case row. Durable only when the transaction commits. */
  public commit(caseRecord: CaseRow): Promise<void> {
    insertObject(this.db, "case", caseRecord);
    return Promise.resolve();
  }
}
