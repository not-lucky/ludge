/**
 * SQLite transaction-only artifact writer.
 *
 * Instances are constructed only by {@link SqliteUnitOfWork}, binding inserts to
 * its writer connection and therefore to the enclosing transaction.
 */

import type { SqliteConnection } from "../connection.js";
import { insertObject } from "../row-io.js";
import type { ArtifactRow } from "../rows.js";

/** Writes artifact rows through one SQLite transaction connection. */
export class SqliteArtifactRepository {
  public constructor(private readonly db: SqliteConnection) {}

  /** Commit an artifact row. Durable only when the transaction commits. */
  public commit(artifact: ArtifactRow): Promise<void> {
    insertObject(this.db, "artifact", artifact);
    return Promise.resolve();
  }
}
