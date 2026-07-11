/**
 * Shipped-asset resolution for the Python harness.
 *
 * The harness is a set of stdlib-only Python files shipped alongside the compiled
 * TypeScript. At runtime this module locates the harness entrypoint
 * (`harness/__main__.py`) relative to its own compiled location, so it resolves
 * correctly whether the package runs from `dist/` (production) or is pointed at a
 * source tree (tests may override the path via config).
 *
 * This module uses Node URL/path builtins, which adapters are permitted to import
 * (only the domain layer must stay runtime-neutral).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** The compiled directory of this module (`…/execution/runtimes/python`). */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path to the shipped harness entrypoint.
 *
 * The entrypoint sits at `harness/__main__.py` next to this module. The Python
 * assets are copied into `dist/` by the build's asset-copy step, mirroring the
 * source layout, so this single resolution rule works in both trees.
 *
 * @returns The absolute path to `harness/__main__.py`.
 */
export function defaultHarnessEntrypoint(): string {
  return join(HERE, "harness", "__main__.py");
}
