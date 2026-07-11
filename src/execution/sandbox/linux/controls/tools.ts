/**
 * Absolute resolution of external control tools.
 *
 * The defense-in-depth controls (`prlimit`, `unshare`, `setpriv`) are launched
 * as wrapper executables around the target. Because the child is spawned with a
 * sanitized `PATH`, and because the parent should not depend on an ambient
 * `PATH` either, wrappers are resolved to an absolute path up-front from a small
 * set of standard system locations. A tool that cannot be resolved makes its
 * control probe as unavailable, so an optional control is simply skipped
 * (degraded enforcement) rather than causing an opaque spawn failure.
 *
 * This is an adapter module and may use Node builtins.
 */

import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

/** Standard directories searched for control tools, most specific first. */
const TOOL_DIRECTORIES: readonly string[] = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
];

/**
 * Resolve a control tool to an absolute, executable path.
 *
 * @param name - The tool's basename (e.g. `"prlimit"`).
 * @returns The absolute path, or `null` if no executable candidate exists.
 */
export async function resolveTool(name: string): Promise<string | null> {
  for (const directory of TOOL_DIRECTORIES) {
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next directory.
    }
  }
  return null;
}
