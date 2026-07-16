/** SQLite transaction-only writer for immutable environment fingerprints. */

import type { SqliteConnection } from "../connection.js";
import type { EnvironmentRow } from "../rows.js";

/**
 * Registers environment snapshots referenced by benchmark runs.
 *
 * The fingerprint is content-addressed by the application, so identical
 * environments are safely reused across runs without turning a valid repeated
 * benchmark into a duplicate-key persistence failure.
 */
export class SqliteEnvironmentRepository {
  public constructor(private readonly db: SqliteConnection) {}

  /** Register one immutable environment row in the enclosing transaction. */
  public register(environment: EnvironmentRow): Promise<void> {
    const columns = Object.keys(environment);
    const placeholders = columns.map((column) => `:${column}`).join(", ");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO environment (${columns.join(", ")}) VALUES (${placeholders})`,
      )
      .run({ ...environment });
    return Promise.resolve();
  }
}
