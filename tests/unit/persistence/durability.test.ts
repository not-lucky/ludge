/**
 * Unit tests for durability configuration and the local-filesystem guard.
 *
 * A real writer connection (via {@link createRawDb}) must actually be in WAL with
 * foreign keys on and the busy timeout applied. A fake connection whose engine
 * refuses WAL must raise {@link DurabilityConfigError} rather than silently run on
 * a weaker journal mode. {@link assertLocalFilesystem} must reject a network-mount
 * magic and accept a local one, driven by an injected probe.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SqliteConnection,
  SqliteStatement,
} from "../../../src/persistence/sqlite/connection.js";
import {
  BUSY_TIMEOUT_MS,
  configureConnection,
} from "../../../src/persistence/sqlite/durability.js";
import { DurabilityConfigError } from "../../../src/persistence/sqlite/errors.js";
import {
  assertLocalFilesystem,
  NETWORK_FILESYSTEM_MAGICS,
} from "../../../src/persistence/sqlite/filesystem-probe.js";
import type { RawDb } from "../../fixtures/persistence/index.js";
import { createRawDb } from "../../fixtures/persistence/index.js";

describe("durability pragmas on a real writer", () => {
  let raw: RawDb;

  beforeEach(() => {
    raw = createRawDb();
  });

  afterEach(() => {
    raw.cleanup();
  });

  it("enables WAL, foreign keys, NORMAL sync, and the busy timeout", () => {
    const journal = raw.db.prepare("PRAGMA journal_mode").get();
    expect(journal?.["journal_mode"]).toBe("wal");

    const fk = raw.db.prepare("PRAGMA foreign_keys").get();
    expect(Number(fk?.["foreign_keys"])).toBe(1);

    const sync = raw.db.prepare("PRAGMA synchronous").get();
    expect(Number(sync?.["synchronous"])).toBe(1);

    const busy = raw.db.prepare("PRAGMA busy_timeout").get();
    expect(Number(busy?.["timeout"])).toBe(BUSY_TIMEOUT_MS);
  });
});

/** A fake connection whose `journal_mode = WAL` pragma reports a downgrade. */
function fakeConnectionWithJournalMode(mode: string): SqliteConnection {
  const statement: SqliteStatement = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => ({ journal_mode: mode }),
    all: () => [],
    iterate: () => [][Symbol.iterator](),
  };
  return {
    path: ":fake:",
    exec: () => undefined,
    prepare: () => statement,
    close: () => undefined,
  };
}

describe("configureConnection", () => {
  it("throws when the engine will not enter WAL on a writer", () => {
    const fake = fakeConnectionWithJournalMode("delete");
    expect(() => configureConnection(fake, "read-write")).toThrow(
      DurabilityConfigError,
    );
  });

  it("does not require WAL for a read-only connection", () => {
    const fake = fakeConnectionWithJournalMode("delete");
    expect(() => configureConnection(fake, "read-only")).not.toThrow();
  });
});

describe("assertLocalFilesystem", () => {
  it("rejects a network filesystem magic", () => {
    const nfsMagic = 0x6969;
    expect(NETWORK_FILESYSTEM_MAGICS.has(nfsMagic)).toBe(true);
    expect(() =>
      assertLocalFilesystem("/mnt/share/store.db", {
        filesystemMagic: () => nfsMagic,
      }),
    ).toThrow(DurabilityConfigError);
  });

  it("accepts a local filesystem magic", () => {
    const ext4Magic = 0xef53;
    expect(() =>
      assertLocalFilesystem("/var/lib/palestra/store.db", {
        filesystemMagic: () => ext4Magic,
      }),
    ).not.toThrow();
  });

  it("accepts an in-memory database without probing", () => {
    expect(() =>
      assertLocalFilesystem(":memory:", {
        filesystemMagic: () => {
          throw new Error("probe must not be called");
        },
      }),
    ).not.toThrow();
  });

  it("fails closed when the probe cannot determine the type", () => {
    expect(() =>
      assertLocalFilesystem("/some/path/store.db", {
        filesystemMagic: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(DurabilityConfigError);
  });
});
