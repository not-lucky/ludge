/**
 * Node implementation of the runtime-neutral filesystem port.
 *
 * Native watcher notifications are intentionally converted into coarse facts.
 * They can be dropped, duplicated, or reordered by the operating system; the
 * watch mediator treats every fact as a request to rescan rather than proof of
 * a particular file transition.
 */

import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { watch as watchNode, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  FileDiscoverOptions,
  FileStat,
  FileSystem,
  FileWatchFact,
  FileWatcher,
  FileWatchHints,
  FileWatchOptions,
} from "../../execution/filesystem.js";

/** Maximum length for an adapter-originated error fact. */
const MAX_WATCH_ERROR_LENGTH = 256;

/**
 * Concrete Node filesystem adapter used only by composition roots.
 *
 * Recursive observation is emulated by subscribing to every currently visible
 * directory when the platform lacks native recursive watch support. A later
 * directory creation is still observed through its parent and causes a rescan;
 * the caller may then replace/reopen the watch after a `reset` fact if desired.
 */
export class NodeFileSystem implements FileSystem {
  public async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  public async stat(path: string): Promise<FileStat> {
    const entry = await stat(path);
    return Object.freeze({
      sizeBytes: entry.size,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      modifiedMsUtc: entry.mtimeMs,
    });
  }

  public async discover(
    root: string,
    options: FileDiscoverOptions,
  ): Promise<readonly string[]> {
    const files: string[] = [];
    await this.collect(resolve(root), options.ignoredDirectoryNames, files);
    files.sort((left, right) => left.localeCompare(right));
    return Object.freeze(files);
  }

  public async createTempRoot(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `${prefix}-`));
  }

  public watchHints(): FileWatchHints {
    return Object.freeze({
      supportsRecursive:
        process.platform === "darwin" || process.platform === "win32",
      coalescingMs: 150,
    });
  }

  public async watch(
    root: string,
    options: FileWatchOptions,
    onFact: (fact: FileWatchFact) => void,
  ): Promise<FileWatcher> {
    const absoluteRoot = resolve(root);
    let closed = false;
    const watchers = new Set<FSWatcher>();
    const emit = (fact: FileWatchFact): void => {
      if (!closed) onFact(fact);
    };
    const attach = (directory: string, recursive: boolean): void => {
      try {
        const watcher = watchNode(
          directory,
          { recursive },
          (eventType, filename) => {
            if (filename === null) {
              emit(Object.freeze({ kind: "reset" }));
              return;
            }
            // Node's event type does not distinguish an atomic rename from a
            // removal/create sequence. Both demand exactly the same rescan.
            const path = resolve(directory, filename.toString());
            if (hasIgnoredDirectory(path, options.ignoredDirectoryNames))
              return;
            emit(Object.freeze({ kind: "change", path }));
            if (eventType === "rename" && !recursive)
              emit(Object.freeze({ kind: "reset" }));
          },
        );
        watcher.on("error", (error: Error) =>
          emit(Object.freeze({ kind: "error", message: boundError(error) })),
        );
        watchers.add(watcher);
      } catch (error) {
        emit(Object.freeze({ kind: "error", message: boundError(error) }));
      }
    };

    const recursive = this.watchHints().supportsRecursive;
    if (recursive) {
      // A native recursive watcher cannot selectively suppress descendants, so
      // facts are filtered at the adapter boundary before reaching policy.
      attach(absoluteRoot, true);
    } else {
      // The static directory set is adequate for notifications as hints. New
      // directories trigger a reset through their watched parent; correctness
      // still comes from the configured-file rescan, never this subscription.
      const directories = await this.directories(
        absoluteRoot,
        options.ignoredDirectoryNames,
      );
      for (const directory of directories) attach(directory, false);
    }

    return Object.freeze({
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        for (const watcher of watchers) watcher.close();
        watchers.clear();
      },
    });
  }

  private async collect(
    root: string,
    ignored: ReadonlySet<string>,
    files: string[],
  ): Promise<void> {
    try {
      const entries = await readdir(root, {
        withFileTypes: true,
        encoding: "utf8",
      });
      for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name))
            await this.collect(path, ignored, files);
        } else if (entry.isFile()) {
          files.push(path);
        }
      }
    } catch {
      // A concurrently removed directory is absent at this instant. Discovery
      // must represent that absence rather than fail a full watch rescan.
      return;
    }
  }

  private async directories(
    root: string,
    ignoredDirectoryNames: ReadonlySet<string>,
  ): Promise<readonly string[]> {
    const directories: string[] = [];
    await this.collectDirectories(root, ignoredDirectoryNames, directories);
    return Object.freeze(directories);
  }

  /** Recursively enumerate directories, including empty directories. */
  private async collectDirectories(
    root: string,
    ignored: ReadonlySet<string>,
    directories: string[],
  ): Promise<void> {
    directories.push(root);
    try {
      const entries = await readdir(root, {
        withFileTypes: true,
        encoding: "utf8",
      });
      for (const entry of entries) {
        if (entry.isDirectory() && !ignored.has(entry.name)) {
          await this.collectDirectories(
            join(root, entry.name),
            ignored,
            directories,
          );
        }
      }
    } catch {
      // A concurrently removed directory has no watcher to install. Its parent
      // has already emitted a hint, so the next configured rescan represents
      // the absence and a later observer recreation can subscribe if restored.
    }
  }
}

function boundError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, MAX_WATCH_ERROR_LENGTH);
}

/**
 * Whether an absolute path belongs to a directory name ignored by watch.
 *
 * This helper is exported for composition tests; policy code ordinarily uses
 * configured target membership rather than querying arbitrary event paths.
 */
export function hasIgnoredDirectory(
  path: string,
  ignored: ReadonlySet<string>,
): boolean {
  return path.split(/[\\/]+/u).some((segment) => ignored.has(segment));
}
