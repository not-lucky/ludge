// @ts-check
/**
 * dependency-cruiser configuration for Palestra Judge.
 *
 * This file is the machine-checked encoding of the layered dependency direction
 * from `docs/architecture/system.md` and `docs/architecture/design-patterns.md`:
 *
 *   cli -> application -> domain
 *                    -> ports <- adapters
 *   infrastructure -> ports and adapters
 *
 * The core invariant is that `domain` is pure: it MUST NOT import any adapter,
 * the CLI, a Node process API, the SQLite driver, or any Python-specific module.
 * Adapters point inward to ports and domain; the composition root in `cli` is the
 * only place allowed to reach across the whole graph to select concrete factories.
 *
 * Path conventions (regex against POSIX-style module paths):
 *   src/domain/          pure contracts
 *   src/application/     use cases / orchestration
 *   src/cli/             command parsing + composition root
 *   src/execution/...    ports + runtime/sandbox adapters
 *   src/judging/         codecs, comparators, fuzzing
 *   src/watch/           watch scheduler policy
 *   src/benchmark/       benchmark policy
 *   src/persistence/     repository ports + SQLite adapter
 *   src/telemetry/       telemetry ports + adapters
 *   src/infrastructure/  config, IDs, hashing, filesystem, clock
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
        "domain MUST import only domain. No adapter, CLI, application, port, " +
        "or infrastructure module may leak into the pure contract layer.",
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
    {
      name: "application-no-adapters",
      comment:
        "application depends on ports, never on concrete adapter internals. " +
        "Concrete selection happens only at the composition root in cli.",
      severity: "error",
      from: { path: "^src/application/" },
      to: {
        path: "^src/(execution/(runtimes|sandbox)|persistence/sqlite|telemetry/adapters)/",
      },
    },

    // --- adapters point inward ----------------------------------------------
    {
      name: "adapters-no-cli-or-application",
      comment:
        "Adapters implement ports and point inward to ports + domain. They MUST " +
        "NOT import the CLI or application use cases.",
      severity: "error",
      from: {
        path: "^src/(execution|judging|watch|benchmark|persistence|telemetry|infrastructure)/",
      },
      to: { path: "^src/(cli|application)/" },
    },

    // --- sibling policies stay independent ----------------------------------
    {
      name: "watch-not-benchmark-or-fuzz",
      comment:
        "watch policy MUST NOT import benchmark or fuzzing concretes; siblings " +
        "share only domain + ports.",
      severity: "error",
      from: { path: "^src/watch/" },
      to: { path: "^src/(benchmark/|judging/fuzzing/)" },
    },
    {
      name: "benchmark-not-watch-or-fuzz",
      comment:
        "benchmark policy MUST NOT import watch or fuzzing concretes; siblings " +
        "share only domain + ports.",
      severity: "error",
      from: { path: "^src/benchmark/" },
      to: { path: "^src/(watch/|judging/fuzzing/)" },
    },
    {
      name: "fuzzing-not-watch-or-benchmark",
      comment:
        "fuzzing policy MUST NOT import watch or benchmark concretes; siblings " +
        "share only domain + ports.",
      severity: "error",
      from: { path: "^src/judging/fuzzing/" },
      to: { path: "^src/(watch/|benchmark/)" },
    },

    // --- hygiene -------------------------------------------------------------
    {
      name: "no-orphans",
      comment: "Unreferenced modules are dead weight; wire them in or remove them.",
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
