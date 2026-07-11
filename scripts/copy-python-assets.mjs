/**
 * Copy the shipped Python harness assets into the build output.
 *
 * `tsc` compiles TypeScript from `src/` to `dist/` but ignores non-TS files, so
 * the stdlib-only Python harness under
 * `src/execution/runtimes/python/harness/**` would be missing from `dist/`. This
 * script mirrors that subtree into
 * `dist/execution/runtimes/python/harness/**` after compilation, so
 * `defaultHarnessEntrypoint()` resolves `harness/__main__.py` next to the
 * compiled adapter in production exactly as it does in the source tree.
 *
 * It is a plain Node ESM script using only `node:fs`/`node:path`/`node:url`,
 * invoked from the `build` npm script after `tsc`.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(here);

const source = join(
  projectRoot,
  "src",
  "execution",
  "runtimes",
  "python",
  "harness",
);
const destination = join(
  projectRoot,
  "dist",
  "execution",
  "runtimes",
  "python",
  "harness",
);

if (!existsSync(source)) {
  throw new Error(`python harness source not found: ${source}`);
}

mkdirSync(dirname(destination), { recursive: true });

// Recursively copy the entire harness tree, excluding compiled Python caches so
// only the pristine source assets are shipped.
cpSync(source, destination, {
  recursive: true,
  filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc"),
});

process.stdout.write(`Copied Python harness assets to ${destination}\n`);
