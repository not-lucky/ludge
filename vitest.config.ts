import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * The three suites from the testing spec live under `tests/`:
 * - `tests/unit`      — pure policy/contract unit tests
 * - `tests/contract`  — port contract fixtures
 * - `tests/black-box` — subprocess-level tests of the real `palestra` binary
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.ts"],
    environment: "node",
    server: {
      deps: {
        // `node:sqlite` is a newer builtin Vite's resolver does not yet know;
        // externalize it so it is required from Node rather than bundled.
        external: [/(?:^|:)sqlite$/u],
      },
    },
  },
  ssr: {
    external: ["node:sqlite"],
  },
});
