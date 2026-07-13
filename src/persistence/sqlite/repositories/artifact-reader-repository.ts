/** Read-only artifact lookup bound to SQLite's query-only connection. */

import type { SqliteConnection } from "../connection.js";
import type { ArtifactRow } from "../rows.js";

/** Reader-side artifact access used by replay; it has no write operation. */
export class SqliteArtifactReaderRepository {
  public constructor(private readonly db: SqliteConnection) {}

  /** Look up immutable artifact metadata by its content identifier. */
  public findById(artifactId: string): Promise<ArtifactRow | null> {
    const row = this.db.prepare("SELECT * FROM artifact WHERE artifact_id = :artifact_id").get({ artifact_id: artifactId });
    return Promise.resolve(row === undefined ? null : row as unknown as ArtifactRow);
  }
}
