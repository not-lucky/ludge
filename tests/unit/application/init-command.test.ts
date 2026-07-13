import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeInitCommand } from "../../../src/application/init-command.js";
import { loadProblemConfig } from "../../../src/infrastructure/config/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "palestra-init-command-"));
  roots.push(value);
  return value;
}

function dependencies(invocationDirectory: string, register = vi.fn(async () => undefined)) {
  return {
    invocationDirectory,
    now: () => "2026-01-02T03:04:05.000Z",
    createId: () => "problem-1",
    transaction: {
      transact: async (work: (uow: never) => Promise<unknown>) => work({
        problems: { findBySlug: async () => null, register },
      } as never),
    } as never,
    register,
  };
}

describe("init command", () => {
  it("exclusively scaffolds a strict schema-v1 YAML document and registers it", async () => {
    const invocationDirectory = await root();
    const deps = dependencies(invocationDirectory);

    const result = await executeInitCommand("two-sum", deps);

    expect(result.status).toBe("passed");
    expect(result.result).toMatchObject({ slug: "two-sum", title: "Two Sum", problemId: "problem-1" });
    const yaml = await readFile(join(invocationDirectory, "problems", "two-sum", "problem.yaml"), "utf8");
    expect(loadProblemConfig(yaml)).toMatchObject({ slug: "two-sum", title: "Two Sum", schemaVersion: 1 });
    expect(deps.register).toHaveBeenCalledWith(expect.objectContaining({
      problem_id: "problem-1", slug: "two-sum", title: "Two Sum", created_at: "2026-01-02T03:04:05.000Z",
    }));
  });

  it("rejects existing and invalid slugs without modifying the registration", async () => {
    const invocationDirectory = await root();
    const deps = dependencies(invocationDirectory);
    await executeInitCommand("two-sum", deps);

    const existing = await executeInitCommand("two-sum", deps);
    const invalid = await executeInitCommand("../escape", deps);

    expect(existing).toMatchObject({ status: "invalid_input", diagnostics: [{ code: "problem_exists" }] });
    expect(invalid).toMatchObject({ status: "invalid_input", diagnostics: [{ code: "invalid_slug" }] });
    expect(deps.register).toHaveBeenCalledTimes(1);
  });

  it("rejects an already registered slug and removes its new scaffold", async () => {
    const invocationDirectory = await root();
    const deps = dependencies(invocationDirectory);
    deps.transaction = {
      transact: async (work: (uow: never) => Promise<unknown>) => work({
        problems: { findBySlug: async () => ({ slug: "two-sum" }), register: deps.register },
      } as never),
    } as never;

    const result = await executeInitCommand("two-sum", deps);

    expect(result).toMatchObject({ status: "invalid_input", diagnostics: [{ code: "problem_exists" }] });
    await expect(readFile(join(invocationDirectory, "problems", "two-sum", "problem.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the directory it created when transactional registration fails", async () => {
    const invocationDirectory = await root();
    const deps = dependencies(invocationDirectory);
    deps.transaction = { transact: async () => { throw new Error("database unavailable"); } } as never;

    const result = await executeInitCommand("two-sum", deps);

    expect(result).toMatchObject({ status: "internal_error", diagnostics: [{ code: "init_failed" }] });
    await expect(readFile(join(invocationDirectory, "problems", "two-sum", "problem.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
