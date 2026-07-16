/** Configured target discovery, hashing, equality, and stability checks. */

import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { FileSystem } from "../execution/filesystem.js";
import { loadProblem } from "../infrastructure/problem.js";
import type {
  WatchFileSnapshot,
  WatchTarget,
  WatchTargetSnapshot,
} from "./contracts.js";
import { WATCH_IGNORED_DIRECTORIES } from "./contracts.js";

/** Hashing seam used by deterministic watch tests. */
export type WatchHash = (bytes: Uint8Array) => string;

/** Dependencies for configured target snapshot construction. */
export interface WatchRescanDependencies {
  readonly fileSystem: FileSystem;
  readonly invocationDirectory: string;
  readonly hash?: WatchHash;
}

/**
 * Scan the actual files that define a fixed-case execution target.
 *
 * `problem.yaml` is always represented, even while absent. If it parses, the
 * resolved solution and recursively discovered case files join the snapshot.
 * An explicit solution override is likewise represented even when missing.
 */
export async function scanWatchTarget(
  target: WatchTarget,
  dependencies: WatchRescanDependencies,
): Promise<WatchTargetSnapshot> {
  const problemYaml = resolve(target.problemRoot, "problem.yaml");
  const candidates = new Set<string>([problemYaml]);
  if (target.solutionOverride !== undefined)
    candidates.add(target.solutionOverride);

  const yaml = await readOptional(dependencies.fileSystem, problemYaml);
  if (yaml !== null) {
    try {
      const problem = loadProblem(new TextDecoder().decode(yaml));
      candidates.add(
        target.solutionOverride === undefined
          ? resolve(target.problemRoot, problem.entrypoint)
          : target.solutionOverride,
      );
      for (const file of await dependencies.fileSystem.discover(
        resolve(target.problemRoot, problem.casesDir),
        {
          ignoredDirectoryNames: WATCH_IGNORED_DIRECTORIES,
        },
      ))
        candidates.add(file);
    } catch {
      // Invalid or partially written YAML deliberately yields a partial
      // snapshot. The generation may run later only after the 50 ms stable
      // recheck; application preparation then reports any persistent config
      // fault through the usual invalid-input outcome.
    }
  }

  const files = await Promise.all(
    [...candidates]
      .sort((left, right) => left.localeCompare(right))
      .map(async (path) =>
        snapshotFile(
          path,
          dependencies.fileSystem,
          dependencies.hash ?? sha256,
        ),
      ),
  );
  const configurationFiles = files.filter(
    (file) =>
      file.path === problemYaml || file.path === target.solutionOverride,
  );
  const inputFiles = files.filter((file) => !configurationFiles.includes(file));
  return Object.freeze({
    target: target.id,
    files: Object.freeze(files),
    inputHash: fingerprint(inputFiles),
    configurationHash: fingerprint(configurationFiles),
  });
}

/** Compare every represented file, including absence, metadata, and content. */
export function equalWatchSnapshots(
  left: WatchTargetSnapshot,
  right: WatchTargetSnapshot,
): boolean {
  return (
    left.target === right.target &&
    left.inputHash === right.inputHash &&
    left.configurationHash === right.configurationHash &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => equalFile(file, right.files[index]))
  );
}

/** Check that a candidate remained exactly stable over the required interval. */
export async function stableWatchSnapshot(
  target: WatchTarget,
  candidate: WatchTargetSnapshot,
  delay: (milliseconds: number) => Promise<void>,
  dependencies: WatchRescanDependencies,
): Promise<WatchTargetSnapshot | null> {
  await delay(50);
  const after = await scanWatchTarget(target, dependencies);
  return equalWatchSnapshots(candidate, after) ? after : null;
}

/** Whether a notification can affect the selected logical target. */
export function isRelevantWatchPath(
  target: WatchTarget,
  path: string,
): boolean {
  return (
    isWithin(target.problemRoot, path) ||
    (target.solutionOverride !== undefined &&
      resolve(path) === resolve(target.solutionOverride))
  );
}

async function snapshotFile(
  path: string,
  fileSystem: FileSystem,
  hash: WatchHash,
): Promise<WatchFileSnapshot> {
  try {
    const metadata = await fileSystem.stat(path);
    if (!metadata.isFile) return Object.freeze({ path, file: null });
    const bytes = await fileSystem.read(path);
    // Stat before and hash after reads; a later stability scan rejects a file
    // that changed while being read, so no partial observation becomes eligible.
    return Object.freeze({
      path,
      file: Object.freeze({
        sizeBytes: metadata.sizeBytes,
        modifiedMsUtc: metadata.modifiedMsUtc,
        sha256: hash(bytes),
      }),
    });
  } catch {
    return Object.freeze({ path, file: null });
  }
}

async function readOptional(
  fileSystem: FileSystem,
  path: string,
): Promise<Uint8Array | null> {
  try {
    return await fileSystem.read(path);
  } catch {
    return null;
  }
}

function equalFile(
  left: WatchFileSnapshot,
  right: WatchFileSnapshot | undefined,
): boolean {
  if (
    right === undefined ||
    left.path !== right.path ||
    left.file === null ||
    right.file === null
  )
    return left.file === right?.file;
  return (
    left.file.sizeBytes === right.file.sizeBytes &&
    left.file.modifiedMsUtc === right.file.modifiedMsUtc &&
    left.file.sha256 === right.file.sha256
  );
}

function fingerprint(files: readonly WatchFileSnapshot[]): string {
  return sha256(new TextEncoder().encode(JSON.stringify(files)));
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function isWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}
