/**
 * SQLite persistence error hierarchy.
 *
 * Every failure raised while opening, configuring, migrating, or writing the
 * durable store is a {@link PersistenceError}. The shape mirrors the error-class
 * style used across the codebase (restore the prototype chain, set `name`, carry
 * a stable machine-readable `reason` code) so callers and reports can react to a
 * failure without parsing a human message.
 *
 * Design note — verdicts are never rewritten. A persistence failure that occurs
 * *after* a verdict has been computed is surfaced (thrown) as an internal /
 * persistence diagnostic: the adapter records the failure but MUST NOT mutate an
 * already-computed verdict. Recovering from a post-verdict persistence fault (for
 * example, reporting `internal_error` while preserving the true verdict) is the
 * caller's concern (task 12), not this layer's.
 *
 * This is an adapter module; it subclasses the ECMAScript built-in {@link Error}
 * only and adds no Node or third-party dependency.
 */

/** A stable, machine-readable classification for a {@link PersistenceError}. */
export type PersistenceErrorReason =
  | "durability-config"
  | "schema-version"
  | "transaction-aborted"
  | "persistence-busy"
  | "integrity-check";

/** Base class for every error raised by the SQLite persistence adapter. */
export class PersistenceError extends Error {
  /**
   * @param reason - Stable machine-readable classification of the failure.
   * @param message - Human-readable, bounded description of the failure.
   */
  public constructor(
    public readonly reason: PersistenceErrorReason,
    message: string,
  ) {
    super(message);
    // Restore the prototype chain across the Error super() call so that
    // `instanceof` works when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Raised when durability cannot be configured as specified: WAL journaling is
 * unavailable, or the database file lives on a network filesystem where WAL is
 * unsafe.
 *
 * This is a hard *configuration* failure. The adapter never silently downgrades
 * the journal mode (for example to `delete` or `memory`) to make a broken host
 * "work"; changing journal semantics behind the operator's back would weaken the
 * durability guarantee the run history depends on.
 */
export class DurabilityConfigError extends PersistenceError {
  /**
   * @param message - Why durability could not be configured.
   */
  public constructor(message: string) {
    super("durability-config", message);
  }
}

/**
 * Raised when the on-disk `user_version` does not match the schema version this
 * build understands: an unknown or newer database that must not be migrated
 * blindly. Only schema v1 is recognized.
 */
export class SchemaVersionError extends PersistenceError {
  /**
   * @param found - The `user_version` read from the database file.
   * @param expected - The schema version this build supports.
   */
  public constructor(
    public readonly found: number,
    public readonly expected: number,
  ) {
    super(
      "schema-version",
      `unsupported database schema version ${found}; this build supports version ${expected}`,
    );
  }
}

/**
 * Raised when a `transact` callback throws (or rejects): the entire transaction
 * has been rolled back and no write was persisted. Wraps the original cause so
 * the caller can inspect the underlying failure.
 */
export class TransactionAbortedError extends PersistenceError {
  /**
   * @param cause - The error the unit-of-work callback threw.
   */
  public constructor(public override readonly cause: unknown) {
    super(
      "transaction-aborted",
      `transaction rolled back: ${describeCause(cause)}`,
    );
  }
}

/**
 * Raised when a write still fails with `SQLITE_BUSY` after the bounded
 * exponential backoff has been exhausted. Surfacing this (rather than blocking
 * forever) keeps a stuck writer observable instead of silently hung.
 */
export class PersistenceBusyError extends PersistenceError {
  /**
   * @param attempts - How many attempts were made before giving up.
   */
  public constructor(public readonly attempts: number) {
    super(
      "persistence-busy",
      `database remained busy after ${attempts} attempt(s); write abandoned`,
    );
  }
}

/**
 * Raised when startup integrity verification fails: `PRAGMA integrity_check`
 * reported corruption, or `PRAGMA foreign_key_check` found dangling references.
 * The store refuses to open a corrupt database rather than compounding damage.
 */
export class IntegrityCheckError extends PersistenceError {
  /**
   * @param failures - The ordered, non-empty list of integrity problems found.
   */
  public constructor(public readonly failures: readonly string[]) {
    super(
      "integrity-check",
      `database integrity check failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
}

/** Render an unknown thrown cause as a bounded, human-readable string. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}
