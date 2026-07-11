/**
 * SQLite {@link ProblemRepository} implementation.
 *
 * A repository instance is bound to one connection: the writer inside a
 * transaction (so `register` participates in the enclosing atomic unit) or a
 * read-only connection as a store accessor (where a write would be rejected by
 * the engine's `query_only` guard). Reads stream through an `AsyncIterable` so a
 * long problem roster is never fully buffered.
 *
 * This is an adapter module; it imports the driver only as a type.
 */

import type { ProblemRepository } from "../../ports/index.js";
import type { SqliteConnection } from "../connection.js";
import { insertObject, readProblemRow } from "../row-io.js";
import type { ProblemRow, SqlitePersistenceRecords } from "../rows.js";

/** A {@link ProblemRepository} backed by a single SQLite connection. */
export class SqliteProblemRepository
  implements ProblemRepository<SqlitePersistenceRecords>
{
  /**
   * @param db - The bound connection (writer inside a transaction, else reader).
   */
  public constructor(private readonly db: SqliteConnection) {}

  /**
   * Register a problem. Durable only within a transaction.
   *
   * @param problem - The problem row to store.
   */
  public register(problem: ProblemRow): Promise<void> {
    insertObject(this.db, "problem", problem);
    return Promise.resolve();
  }

  /**
   * Look up a problem by its unique slug.
   *
   * @param slug - The problem slug.
   * @returns The stored problem, or `null` when none matches.
   */
  public findBySlug(slug: string): Promise<ProblemRow | null> {
    const raw = this.db
      .prepare("SELECT * FROM problem WHERE slug = :slug")
      .get({ slug });
    return Promise.resolve(raw === undefined ? null : readProblemRow(raw));
  }

  /**
   * Stream every registered problem, oldest first.
   *
   * @returns An async stream of problem rows.
   */
  public list(): AsyncIterable<ProblemRow> {
    const statement = this.db.prepare(
      "SELECT * FROM problem ORDER BY created_at ASC, problem_id ASC",
    );
    async function* stream(): AsyncGenerator<ProblemRow> {
      for (const raw of statement.iterate()) {
        yield readProblemRow(raw);
      }
    }
    return stream();
  }
}
