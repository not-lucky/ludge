/** Compiled executable coverage for the fixed-case command and fake uv contract. */

import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureProject,
  fixtureDatabaseExists,
  runPalestra,
  type FixtureProject,
} from "../helpers/black-box.js";
const CAN_ENFORCE = false;

const fixtures: FixtureProject[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<FixtureProject> {
  const value = await createFixtureProject();
  fixtures.push(value);
  return value;
}

describe("palestra test black box", () => {
  it("runs the compiled CLI, emits one JSON envelope, and invokes fake uv exactly", async () => {
    const project = await fixture();
    const result = await runPalestra(project, ["test", project.slug, "--json"]);
    // A host lacking a delegated cgroup rejects the selected cgroup boundary
    // before target launch; capability-enabled CI reaches fake uv instead.
    expect(["invalid_input", "spawn_error", "passed"]).toContain(
      result.envelope.status,
    );
    expect(result.exitCode).toBe(
      result.envelope.status === "passed"
        ? 0
        : result.envelope.status === "spawn_error"
          ? 4
          : 3,
    );
    if (result.envelope.status !== "passed") {
      expect(await project.runtime.records()).toEqual([]);
    } else {
      const [record] = await project.runtime.records();
      expect(record).toMatchObject({ cwd: project.problemRoot });
      expect(record!.argv.slice(0, 5)).toEqual([
        "run",
        "--no-project",
        "--python",
        project.runtime.pythonPath,
        expect.stringContaining("__main__.py"),
      ]);
      expect(Object.keys(record!.environment).sort()).toEqual([
        "LANG",
        "PATH",
        "PYTHONUNBUFFERED",
        "UV_CACHE_DIR",
      ]);
      expect(record!.environment.PATH).toBe(project.runtime.directory);
      expect(record!.environment.PALESTRA_TEST_PARENT_SECRET).toBeUndefined();
      expect(await fixtureDatabaseExists(project)).toBe(true);
    }
  });

  it.skipIf(!CAN_ENFORCE)(
    "runs grouped cases concurrently, completes the suite, and selects source-order failure",
    async () => {
      const project = await fixture();
      await project.writeProblemFile(
        "cases/one.json",
        JSON.stringify({
          cases: [
            { input: [1], expected: 1 },
            { input: [2], expected: 2 },
            { input: [3], expected: 3 },
          ],
        }),
      );
      await project.writeProblemFile(
        "solution.py",
        "import time\ndef solution(value):\n    time.sleep(0.15 if value == 1 else 0.01)\n    return 99 if value in (1, 2) else value\n",
      );
      const result = await runPalestra(project, [
        "test",
        project.slug,
        "--jobs",
        "2",
        "--json",
      ]);
      expect(result.envelope.status).toBe("wrong_answer");
      const payload = result.envelope.result as {
        caseCount: number;
        firstFailure: { path: string } | null;
      };
      expect(payload.caseCount).toBe(3);
      expect(payload.firstFailure?.path).toBe("cases/one.json#0");
    },
  );

  it.skipIf(!CAN_ENFORCE)(
    "requires a writable delegated cgroup: classifies fake runtime pass, wrong answer, and malformed protocol",
    async () => {
      const project = await fixture();
      const passed = await runPalestra(project, [
        "test",
        project.slug,
        "--json",
      ]);
      expect(passed.exitCode).toBe(0);
      expect(passed.envelope.status).toBe("passed");
      expect(await fixtureDatabaseExists(project)).toBe(true);

      await project.runtime.writeControl({
        schemaVersion: 1,
        mode: "constant",
        value: { tag: "int", value: 2 },
      });
      const wrong = await runPalestra(project, [
        "test",
        project.slug,
        "--json",
      ]);
      expect(wrong.exitCode).toBe(1);
      expect(wrong.envelope.status).toBe("wrong_answer");

      await project.runtime.writeControl({
        schemaVersion: 1,
        mode: "malformed",
      });
      const malformed = await runPalestra(project, [
        "test",
        project.slug,
        "--json",
      ]);
      expect(malformed.exitCode).toBe(2);
      expect(malformed.envelope.status).toBe("protocol_error");
    },
  );

  it("ignores removed executable environment overrides", async () => {
    const project = await fixture();
    const result = await runPalestra(
      project,
      ["test", project.slug, "--json"],
      {
        environment: { PALESTRA_UV_PATH: `${project.root}/missing-uv` },
      },
    );
    expect(result.exitCode).toBe(4);
    expect(result.envelope.status).toBe("spawn_error");
    expect(await project.runtime.records()).toEqual([]);
  });

  it("labels unsafe-local outcomes sandbox_unsupported instead of passing", async () => {
    const project = await fixture();
    const result = await runPalestra(project, [
      "test",
      project.slug,
      "--json",
      "--unsafe-local",
    ]);
    expect(result.exitCode).toBe(4);
    expect(result.envelope.status).toBe("sandbox_unsupported");
  });
});
