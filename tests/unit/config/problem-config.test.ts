import { describe, expect, it } from "vitest";
import {
  COMPARISON_POLICY_VERSION,
  DEFAULT_CASES_DIR,
  INPUT_CODEC_VERSION,
  loadProblem,
  loadRunContext,
  OUTPUT_CODEC_VERSION,
  ProblemError,
  type LoadRunContextOptions,
} from "../../../src/infrastructure/problem.js";

const MINIMAL = [
  "schemaVersion: 1",
  "slug: two-sum",
  "title: Two Sum",
  "entrypoint: solution.py",
  "limits: {}",
  "args: [int]",
  "returns: int",
].join("\n");

describe("flat problem.yaml", () => {
  it("loads problem-owned fields and fixed product defaults", () => {
    const problem = loadProblem(MINIMAL);
    expect(problem).toEqual({
      schemaVersion: 1,
      slug: "two-sum",
      title: "Two Sum",
      entrypoint: "solution.py",
      casesDir: DEFAULT_CASES_DIR,
      limits: {},
      runtime: "python-uv",
      inputCodec: INPUT_CODEC_VERSION,
      outputCodec: OUTPUT_CODEC_VERSION,
      comparisonPolicy: COMPARISON_POLICY_VERSION,
      kind: "function",
      args: [{ kind: "int" }],
      returns: { kind: "int" },
    });
    expect(INPUT_CODEC_VERSION).toBe("tagged-jsonl-v1");
    expect(OUTPUT_CODEC_VERSION).toBe("tagged-jsonl-v1");
    expect(COMPARISON_POLICY_VERSION).toBe("exact-v1");
  });

  it("accepts optional problem assets and partial limits", () => {
    const problem = loadProblem(
      `${MINIMAL.replace("limits: {}\nargs", "limits:\n  memoryBytes: 33554432\n  wallTimeMs: 500\nargs")}\ngenerator: generator.py\nnaive: naive.py`,
    );
    expect(problem).toMatchObject({
      generator: "generator.py",
      naive: "naive.py",
      limits: { memoryBytes: 33_554_432, wallTimeMs: 500 },
    });
  });

  it.each([
    ["unknown field", `${MINIMAL}\nruntime: python-uv`],
    [
      "missing title",
      "schemaVersion: 1\nslug: two-sum\nentrypoint: solution.py",
    ],
    ["bad slug", MINIMAL.replace("two-sum", "Two_Sum")],
    ["bad schema", MINIMAL.replace("schemaVersion: 1", "schemaVersion: 2")],
    [
      "bad limit",
      `${MINIMAL.replace("limits: {}", "limits:")}\n  memoryBytes: 0`,
    ],
  ])("rejects %s", (_, text) => {
    expect(() => loadProblem(text)).toThrow(ProblemError);
  });
});

const INVOCATION_DIRECTORY = "/workspace/palestra";
const DECLARED_PROBLEM_ROOT = `${INVOCATION_DIRECTORY}/problems/two-sum`;
const CANONICAL_PROBLEM_ROOT = "/canonical/problems/two-sum";

function loadOptions(
  overrides: Partial<LoadRunContextOptions> = {},
): LoadRunContextOptions {
  return {
    invocationDirectory: INVOCATION_DIRECTORY,
    slug: "two-sum",
    unsafeLocal: false,
    environment: {},
    readText: async () => MINIMAL,
    realpath: async (path) =>
      path === DECLARED_PROBLEM_ROOT ? CANONICAL_PROBLEM_ROOT : path,
    resolveExecutable: async (name) => `/host/bin/${name}`,
    isExecutable: async () => true,
    ...overrides,
  };
}

describe("run context host configuration", () => {
  it("resolves and verifies uv and python3 from PATH, ignoring legacy executable environment variables", async () => {
    const resolved: string[] = [];
    const checked: string[] = [];
    const context = await loadRunContext(
      loadOptions({
        environment: {
          PALESTRA_STATE_DIR: "run-state",
          PALESTRA_CGROUP_PARENT: "/sys/fs/cgroup/delegated/../palestra",
          PALESTRA_UV_PATH: "/must-not-be-used/uv",
          PALESTRA_PYTHON_PATH: "/must-not-be-used/python3",
          PALESTRA_WALL_TIME_MS: "1",
        },
        resolveExecutable: async (name) => {
          resolved.push(name);
          return `/host/bin/${name}`;
        },
        isExecutable: async (path) => {
          checked.push(path);
          return true;
        },
      }),
    );

    expect(context).toMatchObject({
      problemRoot: CANONICAL_PROBLEM_ROOT,
      stateDirectory: `${INVOCATION_DIRECTORY}/run-state`,
      cgroupParentPath: "/sys/fs/cgroup/palestra",
      uvPath: "/host/bin/uv",
      pythonPath: "/host/bin/python3",
    });
    expect(resolved).toEqual(["uv", "python3"]);
    expect(checked).toEqual(["/host/bin/uv", "/host/bin/python3"]);
  });

  it("uses invocation-local state and the delegated cgroup defaults without host environment values", async () => {
    const context = await loadRunContext(loadOptions());

    expect(context.stateDirectory).toBe(`${INVOCATION_DIRECTORY}/.palestra`);
    expect(context.cgroupParentPath).toBe("/sys/fs/cgroup/palestra");
  });

  it("gives explicit host path overrides precedence over the environment", async () => {
    const context = await loadRunContext(
      loadOptions({
        environment: {
          PALESTRA_STATE_DIR: "environment-state",
          PALESTRA_CGROUP_PARENT: "/sys/fs/cgroup/environment",
        },
        stateDirectory: "/explicit/state",
        cgroupParentPath: "/sys/fs/cgroup/explicit/../palestra",
      }),
    );

    expect(context.stateDirectory).toBe("/explicit/state");
    expect(context.cgroupParentPath).toBe("/sys/fs/cgroup/palestra");
  });

  it.each([
    [
      "an empty state directory",
      { PALESTRA_STATE_DIR: "  " },
      "PALESTRA_STATE_DIR must not be empty",
    ],
    [
      "a state directory containing a NUL",
      { PALESTRA_STATE_DIR: "bad\0path" },
      "PALESTRA_STATE_DIR contains a NUL byte",
    ],
    [
      "an empty cgroup parent",
      { PALESTRA_CGROUP_PARENT: " " },
      "PALESTRA_CGROUP_PARENT must not be empty",
    ],
    [
      "a relative cgroup parent",
      { PALESTRA_CGROUP_PARENT: "relative/cgroup" },
      "PALESTRA_CGROUP_PARENT must be an absolute path",
    ],
    [
      "a cgroup parent containing a NUL",
      { PALESTRA_CGROUP_PARENT: "/sys/fs\0/cgroup" },
      "PALESTRA_CGROUP_PARENT must be an absolute path",
    ],
  ])(
    "rejects %s from the host environment",
    async (_, environment, message) => {
      await expect(
        loadRunContext(loadOptions({ environment })),
      ).rejects.toThrow(message);
    },
  );

  it.each([
    ["uv", undefined, "uv executable not found on PATH"],
    ["python3", undefined, "python3 executable not found on PATH"],
  ] as const)(
    "reports when %s cannot be resolved",
    async (missing, path, message) => {
      const resolved: string[] = [];
      await expect(
        loadRunContext(
          loadOptions({
            resolveExecutable: async (name) => {
              resolved.push(name);
              return name === missing ? path : `/host/bin/${name}`;
            },
          }),
        ),
      ).rejects.toThrow(message);
      expect(resolved).toEqual(missing === "uv" ? ["uv"] : ["uv", "python3"]);
    },
  );

  it.each(["uv", "python3"] as const)(
    "reports when resolved %s is not executable",
    async (notExecutable) => {
      await expect(
        loadRunContext(
          loadOptions({
            isExecutable: async (path) => path !== `/host/bin/${notExecutable}`,
          }),
        ),
      ).rejects.toThrow(
        `${notExecutable} is not an executable file: /host/bin/${notExecutable}`,
      );
    },
  );
});
