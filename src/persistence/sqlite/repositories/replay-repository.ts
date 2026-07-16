/** Transaction-only immutable replay-link writer. */

import type { SqliteConnection } from "../connection.js";

/** One replay run's immutable reference to the source artifact it reran. */
export interface ReplayLinkRow {
  readonly replay_run_id: string;
  readonly source_artifact_id: string;
  readonly created_at: string;
}

/** Inserts a replay link inside its owning run transaction. */
export class SqliteReplayRepository {
  public constructor(private readonly db: SqliteConnection) {}

  public commit(link: ReplayLinkRow): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO replay (replay_run_id, source_artifact_id, created_at) VALUES (:replay_run_id, :source_artifact_id, :created_at)",
      )
      .run({ ...link });
    return Promise.resolve();
  }
}
