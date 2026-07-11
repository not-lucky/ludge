/**
 * Local-filesystem probe for the durability guarantee.
 *
 * WAL journaling is safe only on a local filesystem: on a network share the
 * shared-memory coordination WAL relies on is unreliable, so a corrupt or
 * silently-diverging database can result. Before opening the store, the target
 * location is probed and a network filesystem is rejected with a
 * {@link DurabilityConfigError} rather than opened on a weaker footing.
 *
 * Detection uses the `statfs(2)` filesystem "magic" type. We reject a
 * conservative denylist of known network filesystem types (NFS, SMB/CIFS,
 * FUSE-backed network mounts, 9P, Ceph, Lustre, AFS, and the cluster
 * filesystems) rather than allow-listing every local type: local filesystems
 * are far too numerous (ext*, xfs, btrfs, zfs, tmpfs, f2fs, overlay, …) to
 * enumerate without falsely rejecting a legitimate host. The probe is injected
 * so unit tests can drive both outcomes deterministically without a real mount.
 *
 * This is an adapter module and uses Node builtins.
 */

import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DurabilityConfigError } from "./errors.js";

/**
 * Known network / distributed filesystem `statfs` magic numbers, keyed to a
 * human-readable name for diagnostics.
 */
export const NETWORK_FILESYSTEM_MAGICS: ReadonlyMap<number, string> = new Map([
  [0x6969, "NFS"],
  [0xff534d42, "CIFS"],
  [0xfe534d42, "SMB2"],
  [0x517b, "SMB"],
  [0x65735546, "FUSE"],
  [0x564c, "NCP"],
  [0x01021997, "9P"],
  [0x5346414f, "AFS"],
  [0x00c36400, "Ceph"],
  [0x01161970, "GFS2"],
  [0x7461636f, "OCFS2"],
  [0x0bd00bd0, "Lustre"],
]);

/**
 * A probe that reports the filesystem type magic number for a path.
 *
 * Injected so tests can simulate a network mount without one being present.
 */
export interface FilesystemProbe {
  /**
   * Return the `statfs` magic number for the filesystem containing `path`.
   *
   * @param path - An existing path on the target filesystem.
   * @returns The filesystem type magic number.
   */
  filesystemMagic(path: string): number;
}

/** The default probe, backed by the synchronous `statfs(2)` syscall. */
export function createStatfsProbe(): FilesystemProbe {
  return {
    filesystemMagic(path: string): number {
      return statfsSync(path).type;
    },
  };
}

/**
 * Assert that the database at `dbPath` lives on a local filesystem.
 *
 * The parent directory is probed (the database file itself may not exist yet on
 * a first open). An in-memory database (`":memory:"`) has no filesystem and is
 * accepted. When the probe itself fails (the path cannot be stat'd) the location
 * cannot be proven local, so it is rejected fail-closed.
 *
 * @param dbPath - The database file path.
 * @param probe - The filesystem probe (defaults to a real `statfs` probe).
 * @throws {DurabilityConfigError} If the path is on a network filesystem or the
 *   filesystem type cannot be determined.
 */
export function assertLocalFilesystem(
  dbPath: string,
  probe: FilesystemProbe = createStatfsProbe(),
): void {
  if (dbPath === ":memory:") {
    return;
  }

  let magic: number;
  try {
    magic = probe.filesystemMagic(dirname(dbPath));
  } catch (error) {
    throw new DurabilityConfigError(
      `cannot determine the filesystem type for ${dbPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const networkName = NETWORK_FILESYSTEM_MAGICS.get(magic);
  if (networkName !== undefined) {
    throw new DurabilityConfigError(
      `database path ${dbPath} is on a ${networkName} network filesystem; ` +
        `WAL requires a local filesystem`,
    );
  }
}
