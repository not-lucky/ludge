// @ts-check
/**
 * dependency-cruiser configuration for Palestra Judge.
 *
 * This file enforces the dependency direction of the current source tree:
 *
 *   cli -> application -> domain
 *   infrastructure / execution / persistence -> domain
 *
 * The core invariant is that `domain` is pure: it MUST NOT import the CLI,
 * application, runtime adapters, Node process APIs, or npm packages. The CLI is
 * the composition root; implementation domains must not depend on it or on
 * application commands.
 *
 * Path conventions (regex against POSIX-style module paths):
 *   src/domain/          pure contracts and state
 *   src/application/     command orchestration
 *   src/cli/             parsing, composition, and process lifecycle
 *   src/execution/       runner, sandbox, and host seams
 *   src/judging/         codecs and comparators
 *   src/watch/           watch scheduling policy
 *   src/benchmark/       benchmark policy
 *   src/persistence/     SQLite storage and transaction ownership
 *   src/telemetry/       event publishing and rendering
 *   src/infrastructure/  problem parsing and Node filesystem binding
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Circular dependencies indicate a leaky seam; break the cycle.",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    // --- domain purity -------------------------------------------------------
    {
      name: "domain-is-pure",
      comment:
        "domain MUST import only domain. No CLI, application, runtime, or " +
        "infrastructure module may leak into the pure contract layer.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: {
        pathNot: ["^src/domain/", "^node_modules/typescript/"],
        path: "^src/(cli|application|execution|judging|watch|benchmark|persistence|telemetry|infrastructure)/",
      },
    },
    {
      name: "domain-no-node-builtins",
      comment:
        "domain MUST NOT import Node process APIs; keep it runtime-neutral.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "domain-no-npm",
      comment:
        "domain MUST NOT depend on external npm packages (e.g. SQLite drivers).",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer"] },
    },

    // --- application boundaries ---------------------------------------------
    {
      name: "application-no-cli",
      comment:
        "application (use cases) MUST NOT depend on the CLI; the CLI depends " +
        "on application, not the reverse.",
      severity: "error",
      from: { path: "^src/application/" },
      to: { path: "^src/cli/" },
    },

    // --- implementation domains do not call command layers -----------------
    {
      name: "implementation-no-cli-or-application",
      comment:
        "Implementation domains MUST NOT import the CLI or application use cases.",
      severity: "error",
      from: {
        path: "^src/(execution|judging|watch|benchmark|persistence|telemetry|infrastructure)/",
      },
      to: { path: "^src/(cli|application)/" },
    },

    // --- active sibling policies stay independent ---------------------------
    {
      name: "watch-not-benchmark",
      comment:
        "watch policy MUST NOT import benchmark policy; the command layer " +
        "coordinates both when needed.",
      severity: "error",
      from: { path: "^src/watch/" },
      to: { path: "^src/benchmark/" },
    },
    {
      name: "benchmark-not-watch",
      comment:
        "benchmark policy MUST NOT import watch policy; the command layer " +
        "coordinates both when needed.",
      severity: "error",
      from: { path: "^src/benchmark/" },
      to: { path: "^src/watch/" },
    },

    // --- hygiene -------------------------------------------------------------
    {
      name: "no-orphans",
      comment:
        "Unreferenced modules are dead weight; wire them in or remove them.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          "(^|/)\\.gitkeep$",
          "(^|/)tsconfig\\.json$",
          "^src/cli/main\\.ts$",
        ],
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".d.ts"],
    },
  },
};
