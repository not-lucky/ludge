/**
 * Safe path resolution for problem-local and CLI-supplied paths.
 *
 * The CLI contract fixes how paths are resolved and bounded: a path is resolved
 * relative to the invocation directory, or relative to the problem root for a
 * problem-local default; NUL bytes and paths that escape the problem root are
 * invalid; and a path supplied by a CLI option wins over a problem-local
 * default. Centralizing these rules here keeps every command from re-deriving
 * (and subtly diverging on) the containment and override logic.
 *
 * This is infrastructure and may use Node path builtins.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { PathResolutionError } from "./errors.js";

/** The two roots every path is resolved against. */
export interface PathContext {
  /** Absolute directory the CLI was invoked from (CLI paths resolve here). */
  readonly invocationDir: string;
  /** Absolute problem root (`problems/<slug>/`; problem-local paths resolve here). */
  readonly problemRoot: string;
}

/**
 * Reject a path containing a NUL byte.
 *
 * A NUL byte cannot appear in a legitimate path and is a classic truncation
 * attack against C-level filesystem APIs, so it fails closed here before the
 * path is ever handed to the OS.
 *
 * @param path - The raw path text.
 * @throws {PathResolutionError} If `path` contains `\0`.
 */
export function assertNoNulByte(path: string): void {
  if (path.includes("\0")) {
    throw new PathResolutionError("path contains a NUL byte", path);
  }
}

/**
 * Resolve a CLI-supplied path against the invocation directory.
 *
 * An absolute path is taken as-is; a relative path is resolved against
 * {@link PathContext.invocationDir}. CLI paths are intentionally NOT constrained
 * to the problem root — the user may point at a solution or case file anywhere
 * they choose.
 *
 * @param ctx - The resolution roots.
 * @param path - The CLI-supplied path.
 * @returns The absolute, normalized path.
 * @throws {PathResolutionError} If `path` contains a NUL byte.
 */
export function resolveInvocationPath(ctx: PathContext, path: string): string {
  assertNoNulByte(path);
  return isAbsolute(path) ? resolve(path) : resolve(ctx.invocationDir, path);
}

/**
 * Resolve a problem-local path against the problem root, enforcing containment.
 *
 * The resulting path must lie inside {@link PathContext.problemRoot}; a value
 * that normalizes to an ancestor, a sibling, or an absolute location elsewhere
 * (for example `../../etc/passwd`) is rejected rather than silently clamped.
 *
 * @param ctx - The resolution roots.
 * @param path - The problem-relative path (from `problem.yaml`).
 * @returns The absolute, normalized path inside the problem root.
 * @throws {PathResolutionError} If `path` contains a NUL byte or escapes the
 *   problem root.
 */
export function resolveProblemLocalPath(
  ctx: PathContext,
  path: string,
): string {
  assertNoNulByte(path);
  const resolved = resolve(ctx.problemRoot, path);
  const rel = relative(ctx.problemRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathResolutionError(
      "path escapes the problem root",
      path,
    );
  }
  return resolved;
}

/** A problem-local default that a CLI option may override. */
export interface OverridablePath {
  /** The optional CLI-supplied override (resolved against the invocation dir). */
  readonly cliOverride?: string | undefined;
  /** The problem-local default (resolved against, and confined to, the root). */
  readonly problemLocalDefault: string;
}

/**
 * Resolve a path where a CLI option, when present, overrides a problem-local
 * default.
 *
 * When `cliOverride` is supplied it wins and is resolved against the invocation
 * directory (unconfined); otherwise the problem-local default is resolved
 * against the problem root and must stay inside it.
 *
 * @param ctx - The resolution roots.
 * @param spec - The override and the problem-local default.
 * @returns The absolute, normalized path.
 * @throws {PathResolutionError} For a NUL byte, or a default that escapes the
 *   problem root.
 */
export function resolveOverridablePath(
  ctx: PathContext,
  spec: OverridablePath,
): string {
  if (spec.cliOverride !== undefined) {
    return resolveInvocationPath(ctx, spec.cliOverride);
  }
  return resolveProblemLocalPath(ctx, spec.problemLocalDefault);
}
