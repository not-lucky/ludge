/**
 * Filesystem port.
 *
 * A {@link FileSystem} exposes the narrow, runtime-neutral filesystem
 * operations the judge needs: reading bounded inputs, stat-ing entries,
 * allocating isolated temporary roots for a run, and reporting change-watch
 * capabilities. Concrete host bindings live in an adapter; policy code depends
 * only on this contract.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/** Metadata about a single filesystem entry. */
export interface FileStat {
  /** Size in bytes. */
  readonly sizeBytes: number;
  /** Whether the entry is a regular file. */
  readonly isFile: boolean;
  /** Whether the entry is a directory. */
  readonly isDirectory: boolean;
  /** Last-modified time in milliseconds since the Unix epoch (UTC). */
  readonly modifiedMsUtc: number;
}

/**
 * Capability hints describing how the host reports filesystem changes.
 *
 * The watch scheduler (task 15) uses these to tune debouncing and recursion;
 * this is a minimal placeholder that task refines as watch mode is built.
 */
export interface FileWatchHints {
  /** Whether the host can watch a directory tree recursively in one watcher. */
  readonly supportsRecursive: boolean;
  /** Suggested debounce window, in milliseconds, to coalesce change bursts. */
  readonly coalescingMs: number;
}

/** A non-authoritative filesystem notification reported by a watcher. */
export type FileWatchFact =
  | Readonly<{ readonly kind: "change"; readonly path: string }>
  | Readonly<{ readonly kind: "overflow" }>
  | Readonly<{ readonly kind: "reset" }>
  | Readonly<{ readonly kind: "error"; readonly message: string }>;

/** A closeable subscription to asynchronous filesystem facts. */
export interface FileWatcher {
  /** Stop observation and release all host watcher resources. Idempotent. */
  close(): Promise<void>;
}

/** Options that keep recursive discovery bounded and policy controlled. */
export interface FileDiscoverOptions {
  /** Directory names never traversed, regardless of depth. */
  readonly ignoredDirectoryNames: ReadonlySet<string>;
}

/** Options that constrain a host watcher to relevant directories. */
export interface FileWatchOptions {
  /** Directory names the adapter must not subscribe to or report from. */
  readonly ignoredDirectoryNames: ReadonlySet<string>;
}

/**
 * Runtime-neutral filesystem access used by execution and watch policy.
 *
 * Reads are bounded by the caller's limits; the port itself performs no
 * verdict-affecting logic.
 */
export interface FileSystem {
  /**
   * Read the entire contents of a file as bytes.
   *
   * @param path - The file path to read.
   * @returns The file bytes.
   */
  read(path: string): Promise<Uint8Array>;
  /**
   * Stat a filesystem entry.
   *
   * @param path - The path to stat.
   * @returns The entry metadata.
   */
  stat(path: string): Promise<FileStat>;
  /**
   * Enumerate regular files below `root`, omitting directories named by
   * `options.ignoredDirectoryNames`. Returned paths are absolute and stable in
   * lexical order; callers still stat/read them because discovery is only a
   * point-in-time observation.
   */
  discover(
    root: string,
    options: FileDiscoverOptions,
  ): Promise<readonly string[]>;
  /**
   * Begin reporting host notifications rooted at `root`.
   *
   * Facts are hints, never an authoritative change order. Consumers must rescan
   * their configured inputs before making a correctness-sensitive decision.
   */
  watch(
    root: string,
    options: FileWatchOptions,
    onFact: (fact: FileWatchFact) => void,
  ): Promise<FileWatcher>;
  /**
   * Create a fresh, isolated temporary root directory for a run and return its
   * path. Callers own cleanup of the returned directory.
   *
   * @param prefix - A human-readable prefix for the directory name.
   * @returns The absolute path of the created temporary root.
   */
  createTempRoot(prefix: string): Promise<string>;
  /**
   * Report this host's change-watch capabilities.
   *
   * @returns The watch capability hints.
   */
  watchHints(): FileWatchHints;
}
