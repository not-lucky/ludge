/** Compiled-CLI black-box process and temporary-project utilities. */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeUvRuntime, type FakeUvRuntime } from "./fake-uv.js";

/** Version-1 CLI JSON envelope observed from the compiled executable. */
export interface BlackBoxEnvelope {
  readonly schemaVersion: 1;
  readonly command: string | null;
  readonly correlationId: string | null;
  readonly status: string;
  readonly exitCode: number;
  readonly result: unknown;
  readonly diagnostics: readonly unknown[];
}

/** Result of one bounded compiled-CLI process execution. */
export interface BlackBoxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: BlackBoxEnvelope;
}

/** Temporary invocation root and configured test-only runtime. */
export interface FixtureProject {
  readonly root: string;
  readonly runtime: FakeUvRuntime;
  readonly slug: string;
  readonly problemRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  writeProblemFile(relativePath: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CLI_ENTRYPOINT = join(REPOSITORY_ROOT, "dist", "cli", "main.js");

/** Create a complete minimal problem project with one deterministic case. */
export async function createFixtureProject(
  slug = "sample",
): Promise<FixtureProject> {
  const root = await mkdtemp(join(tmpdir(), "palestra-black-box-"));
  const runtime = await createFakeUvRuntime(root);
  const problemRoot = join(root, "problems", slug);
  await mkdir(join(problemRoot, "cases"), { recursive: true });
  await writeFile(
    join(problemRoot, "problem.yaml"),
    [
      "schemaVersion: 1",
      `slug: ${slug}`,
      "title: Black Box Fixture",
      "entrypoint: solution.py",
      "limits: {}",
      "casesDir: cases",
      "args: [int]",
      "returns: int",
    ].join("\n"),
  );
  await writeFile(join(problemRoot, "problem.md"), "# Black Box Fixture\n");
  await writeFile(
    join(problemRoot, "solution.py"),
    "def solution(value): return value\n",
  );
  await writeFile(
    join(problemRoot, "cases", "one.json"),
    JSON.stringify({ input: [1], expected: 1 }),
  );
  const environment = Object.freeze({
    PALESTRA_UV_PATH: runtime.executable,
    PALESTRA_PYTHON_PATH: runtime.pythonPath,
    PALESTRA_UV_CACHE_DIR: runtime.cacheDirectory,
    PALESTRA_TEMP_DIR: join(root, "sandbox-temp"),
    PALESTRA_CGROUP_PARENT:
      process.env.PALESTRA_TEST_CGROUP_PARENT ?? "/sys/fs/cgroup",
  });
  return {
    root,
    runtime,
    slug,
    problemRoot,
    environment,
    async writeProblemFile(relativePath, content): Promise<void> {
      const path = resolve(problemRoot, relativePath);
      if (!path.startsWith(`${problemRoot}/`)) {
        throw new RangeError("fixture path escapes problem root");
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Run the prebuilt executable and require its one JSON stdout envelope. */
export async function runPalestra(
  fixture: FixtureProject,
  args: readonly string[],
  options: Readonly<{
    environment?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  }> = {},
): Promise<BlackBoxResult> {
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? fixture.root,
    PALESTRA_TEST_PARENT_SECRET: "must-not-reach-target",
    ...fixture.environment,
    ...(options.environment ?? {}),
  };
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRYPOINT, ...args], {
      cwd: fixture.root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    const timeout = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? 15_000,
    );
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        if (lines.length !== 1)
          throw new Error(
            `expected one stdout JSON envelope, got ${lines.length}`,
          );
        resolveResult({
          exitCode: code ?? -1,
          stdout,
          stderr,
          envelope: JSON.parse(lines[0]!) as BlackBoxEnvelope,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Read the durable SQLite file without making it a production dependency. */
export async function fixtureDatabaseExists(
  fixture: FixtureProject,
): Promise<boolean> {
  try {
    await readFile(join(fixture.root, ".palestra", "judge.sqlite"));
    return true;
  } catch {
    return false;
  }
}
