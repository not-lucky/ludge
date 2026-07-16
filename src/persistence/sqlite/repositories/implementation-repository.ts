/**
 * SQLite transaction-only implementation writer.
 *
 * Instances are constructed only by {@link SqliteUnitOfWork}, binding inserts to
 * its writer connection and therefore to the enclosing transaction.
 */

import type { SqliteConnection } from "../connection.js";
import type { SqlParams } from "../connection.js";
import type { ImplementationRow } from "../rows.js";

/** Writes implementation rows through one SQLite transaction connection. */
export class SqliteImplementationRepository {
  public constructor(private readonly db: SqliteConnection) {}

  /** Register an implementation row. Durable only when the transaction commits. */
  public register(implementation: ImplementationRow): Promise<void> {
    // Implementations are content-addressed by the application. Repeated test
    // runs therefore reuse their immutable registration rather than turning a
    // valid second run into a duplicate-key persistence diagnostic.
    const columns = Object.keys(implementation);
    const params: SqlParams = { ...implementation };
    const placeholders = columns.map((column) => `:${column}`).join(", ");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO implementation (${columns.join(", ")}) VALUES (${placeholders})`,
      )
      .run(params);
    return Promise.resolve();
  }
}
