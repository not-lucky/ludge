/**
 * Thin, driver-shaped wrapper over the `node:sqlite` built-in.
 *
 * This is the single module in the adapter that imports `node:sqlite`. Every
 * other module depends on the small {@link SqliteConnection} / {@link
 * SqliteStatement} surface declared here, so the rest of the persistence layer
 * is driver-shaped rather than driver-bound: swapping the underlying driver
 * would touch only this file. The wrapper deliberately exposes just what the
 * store needs (exec, prepared statements, close) and normalizes reads to
 * `BigInt` so nanosecond and byte columns never silently lose precision.
 *
 * `node:sqlite` is synchronous. That is exactly what the single-writer model
 * wants: statements on one connection are naturally serialized. The async port
 * surface is honored one layer up (the writer queue and repositories wrap these
 * synchronous calls in resolved promises).
 *
 * This is an adapter module and uses Node builtins.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * The `node:sqlite` `DatabaseSync` constructor, obtained via
 * {@link process.getBuiltinModule} rather than a static `import`.
 *
 * `node:sqlite` is a newer builtin that some bundlers/test transformers do not
 * yet recognize and mis-resolve (stripping the `node:` prefix). Loading it
 * through `process.getBuiltinModule` keeps the module a pure Node builtin at
 * runtime while the `import type` above still supplies the compile-time types.
 */
const DatabaseSyncCtor = process.getBuiltinModule("node:sqlite").DatabaseSync;

/** A value that can be bound to a statement parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** A value that can be read back from a column. */
export type SqlOutputValue = null | number | bigint | string | Uint8Array;

/** Named parameters bound to a statement (keys match `:name` placeholders). */
export type SqlParams = Record<string, SqlValue>;

/** A single row as a column-name → value map. */
export type SqliteRow = Record<string, SqlOutputValue>;

/** Summary of a mutating statement's effect. */
export interface RunSummary {
  /** Number of rows inserted, updated, or deleted. */
  readonly changes: number;
  /** The rowid of the most recent insert (rarely needed; PKs are explicit). */
  readonly lastInsertRowid: number | bigint;
}

/**
 * A prepared statement, reduced to the operations the adapter uses.
 *
 * All read methods return integers as `bigint` (see {@link SqliteConnection});
 * callers coerce to `number` only for columns known to be small (ordinals,
 * counts) via the mapper helpers.
 */
export interface SqliteStatement {
  /**
   * Execute a mutating statement.
   *
   * @param params - Named parameters to bind, or none.
   * @returns A summary of the rows affected.
   */
  run(params?: SqlParams): RunSummary;
  /**
   * Execute and return the first row, or `undefined` when none.
   *
   * @param params - Named parameters to bind, or none.
   */
  get(params?: SqlParams): SqliteRow | undefined;
  /**
   * Execute and return every row.
   *
   * @param params - Named parameters to bind, or none.
   */
  all(params?: SqlParams): SqliteRow[];
  /**
   * Execute and stream rows lazily via an iterator.
   *
   * @param params - Named parameters to bind, or none.
   */
  iterate(params?: SqlParams): IterableIterator<SqliteRow>;
}

/**
 * A single SQLite connection, reduced to the operations the adapter uses.
 *
 * Integer columns are always read as `bigint` (via `setReadBigInts`) so a
 * 64-bit nanosecond or byte value is never truncated to a JS `number`.
 */
export interface SqliteConnection {
  /** The database file path this connection was opened against. */
  readonly path: string;
  /**
   * Execute one or more SQL statements that return no rows (DDL, `BEGIN`,
   * `COMMIT`, `ROLLBACK`).
   *
   * @param sql - The SQL text.
   */
  exec(sql: string): void;
  /**
   * Compile a SQL statement into a reusable prepared statement.
   *
   * @param sql - The SQL text with `:name` parameter placeholders.
   * @returns The prepared statement.
   */
  prepare(sql: string): SqliteStatement;
  /** Close the underlying connection. Idempotent-safe at the call site. */
  close(): void;
}

/** Wrap a `node:sqlite` `StatementSync` as an {@link SqliteStatement}. */
function wrapStatement(
  statement: ReturnType<DatabaseSync["prepare"]>,
): SqliteStatement {
  // Read every INTEGER column as BigInt so 64-bit ns/byte values are exact.
  statement.setReadBigInts(true);
  // Permit binding named parameters without the ':' prefix in JS keys.
  statement.setAllowBareNamedParameters(true);
  return {
    run(params?: SqlParams): RunSummary {
      const result =
        params === undefined ? statement.run() : statement.run(params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    get(params?: SqlParams): SqliteRow | undefined {
      return params === undefined ? statement.get() : statement.get(params);
    },
    all(params?: SqlParams): SqliteRow[] {
      return params === undefined ? statement.all() : statement.all(params);
    },
    iterate(params?: SqlParams): IterableIterator<SqliteRow> {
      const iterator =
        params === undefined ? statement.iterate() : statement.iterate(params);
      return iterator as IterableIterator<SqliteRow>;
    },
  };
}

/** Wrap a `node:sqlite` `DatabaseSync` as an {@link SqliteConnection}. */
function wrapConnection(db: DatabaseSync, path: string): SqliteConnection {
  return {
    path,
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      return wrapStatement(db.prepare(sql));
    },
    close(): void {
      if (db.isOpen) {
        db.close();
      }
    },
  };
}

/**
 * Open a read-write connection to the database at `path`, creating the file if
 * it does not exist.
 *
 * Durability configuration (WAL, synchronous, foreign keys) is applied
 * separately by the store so this module stays a pure driver seam.
 *
 * @param path - The database file path.
 * @returns A writable {@link SqliteConnection}.
 */
export function openWriter(path: string): SqliteConnection {
  // Foreign keys are configured explicitly by the durability step; disable the
  // constructor's implicit enabling so the single configuration path owns it.
  const db = new DatabaseSyncCtor(path, { enableForeignKeyConstraints: false });
  return wrapConnection(db, path);
}

/**
 * Open a read-only connection to an existing database at `path`.
 *
 * Opening fails if the file does not exist. Read-only connections never enter
 * the writer queue and never begin a write transaction.
 *
 * @param path - The database file path.
 * @returns A read-only {@link SqliteConnection}.
 */
export function openReader(path: string): SqliteConnection {
  const db = new DatabaseSyncCtor(path, {
    readOnly: true,
    enableForeignKeyConstraints: false,
  });
  return wrapConnection(db, path);
}
