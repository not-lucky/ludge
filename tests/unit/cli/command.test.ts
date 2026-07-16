import { describe, expect, it } from "vitest";

import {
  dispatchCommand,
  parseCommand,
  type CommandHandlers,
} from "../../../src/cli/command.js";
import { ExitCode, outcome } from "../../../src/cli/outcome.js";
import { renderOutcome, type CliWriters } from "../../../src/cli/output.js";

const parserDependencies = { createCorrelationId: () => "correlation-1" };

function expectCommand(argv: readonly string[]) {
  const result = parseCommand(argv, parserDependencies);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected command");
  return result.command;
}

function writers(): {
  readonly writers: CliWriters;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    writers: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

describe("parseCommand", () => {
  it("parses all documented command forms into immutable serializable commands", () => {
    expect(expectCommand(["init", "two-sum", "--json"])).toMatchObject({
      name: "init",
      correlationId: "correlation-1",
      options: { slug: "two-sum", json: true },
    });
    expect(
      expectCommand([
        "--unsafe-local",
        "test",
        "two-sum",
        "--solution",
        "solution.py",
        "--case",
        "case.json",
        "--jobs",
        "4",
        "--json",
      ]),
    ).toMatchObject({
      name: "test",
      options: {
        unsafeLocal: true,
        solution: "solution.py",
        case: "case.json",
        jobs: 4,
        json: true,
      },
    });
    expect(
      expectCommand([
        "stress-test",
        "two-sum",
        "--unsafe-local",
        "--generator",
        "gen.py",
        "--naive",
        "naive.py",
        "--solution",
        "solution.py",
        "--seed",
        "18446744073709551615",
        "--cases",
        "2",
        "--duration",
        "3",
        "--jobs",
        "1",
        "--shrink",
        "--json",
      ]),
    ).toMatchObject({
      name: "stress-test",
      options: {
        seed: "18446744073709551615",
        cases: 2,
        duration: 3,
        jobs: 1,
        shrink: true,
        unsafeLocal: true,
      },
    });
    expect(
      expectCommand(["watch", "two-sum", "--debounce", "0"]),
    ).toMatchObject({ name: "watch", options: { debounce: 0 } });
    expect(
      expectCommand([
        "benchmark",
        "two-sum",
        "--solutions",
        "a.py,b.py",
        "--warmup",
        "0",
        "--samples",
        "2",
      ]),
    ).toMatchObject({
      name: "benchmark",
      options: { solutions: ["a.py", "b.py"], warmup: 0, samples: 2 },
    });
    expect(
      expectCommand(["report", "two-sum", "--since", "2025-01-31", "--json"]),
    ).toMatchObject({
      name: "report",
      options: { slug: "two-sum", since: "2025-01-31", json: true },
    });
    expect(
      expectCommand(["replay", "artifact-1", "--unsafe-local"]),
    ).toMatchObject({
      name: "replay",
      options: { artifactId: "artifact-1", unsafeLocal: true },
    });
  });

  it.each([
    [["test", "bad slug"], "invalid_slug"],
    [["init", "ok", "--unsafe-local"], "unsupported_option"],
    [["report", "--unsafe-local"], "unsupported_option"],
    [["test", "ok", "--wat"], "unknown_option"],
    [["test", "ok", "--json", "--json"], "duplicate_option"],
    [["test", "ok", "--solution"], "missing_option_value"],
    [
      ["stress-test", "ok", "--seed", "18446744073709551616"],
      "number_out_of_range",
    ],
    [["stress-test", "ok", "--cases", "0"], "number_out_of_range"],
    [["test", "ok", "--jobs", "0"], "number_out_of_range"],
    [["test", "ok", "--jobs", "not-a-number"], "invalid_number"],
    [["test", "ok", "--jobs", "1", "--jobs", "2"], "duplicate_option"],
    [["benchmark", "ok", "--solutions", "only.py"], "invalid_solutions"],
    [["report", "--since", "2025-02-29"], "invalid_date"],
  ])(
    "returns invalid-input exit 3 for malformed argv %#",
    (argv, diagnosticCode) => {
      const result = parseCommand(argv, parserDependencies);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.outcome.exitCode).toBe(ExitCode.InvalidInput);
      expect(result.outcome.diagnostics[0]?.code).toBe(diagnosticCode);
    },
  );

  it("preserves JSON mode for parse failures", () => {
    const result = parseCommand(
      ["test", "ok", "--json", "--unknown"],
      parserDependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.json).toBe(true);
  });
});

describe("CLI outcome rendering and dispatch", () => {
  it("maps structured statuses through the stable exit table", () => {
    expect(outcome("passed").exitCode).toBe(0);
    expect(outcome("wrong_answer").exitCode).toBe(1);
    expect(outcome("signaled").exitCode).toBe(2);
    expect(outcome("invalid_input").exitCode).toBe(3);
    expect(outcome("sandbox_unsupported").exitCode).toBe(4);
    expect(outcome("internal_error").exitCode).toBe(5);
    expect(outcome("canceled").exitCode).toBe(130);
  });

  it("renders a passing test summary without per-case noise and exactly one first failure", () => {
    const command = expectCommand(["test", "ok"]);
    const output = writers();
    renderOutcome(
      output.writers,
      "human",
      command,
      outcome("wrong_answer", {
        runId: "run-1",
        caseCount: 3,
        passedCaseCount: 1,
        statusCounts: { passed: 1, wrong_answer: 2 },
        artifactId: "artifact-1",
        firstFailure: {
          caseId: "case-1",
          path: "cases/a.json#0",
          status: "wrong_answer",
          durationMs: 12,
          input: "[1, 2]",
          expected: "3",
          actual: "4",
          error: null,
        },
        cases: [
          {
            caseId: "case-1",
            path: "cases/a.json#0",
            status: "wrong_answer",
            durationMs: 12,
          },
          {
            caseId: "case-2",
            path: "cases/a.json#1",
            status: "wrong_answer",
            durationMs: 13,
          },
          {
            caseId: "case-3",
            path: "cases/b.json",
            status: "passed",
            durationMs: 1,
          },
        ],
      }),
    );
    expect(output.stdout.join("")).toContain("Test wrong_answer: 1/3 passed");
    expect(output.stdout.join("")).toContain("First failure: cases/a.json#0");
    expect(output.stdout.join("")).toContain("Input: [1, 2]");
    expect(output.stdout.join("")).toContain("Expected: 3");
    expect(output.stdout.join("")).toContain("Actual: 4");
    expect(output.stdout.join("")).not.toContain("cases/a.json#1");
    expect(output.stderr).toEqual([]);
  });

  it("shows an execution error instead of an unavailable actual output", () => {
    const command = expectCommand(["test", "ok"]);
    const output = writers();
    renderOutcome(
      output.writers,
      "human",
      command,
      outcome("tle_wall", {
        runId: "run-1",
        caseCount: 1,
        passedCaseCount: 0,
        statusCounts: { tle_wall: 1 },
        artifactId: "artifact-1",
        firstFailure: {
          caseId: "case-1",
          path: "cases/slow.json#0",
          status: "tle_wall",
          durationMs: 2001,
          input: "[42]",
          expected: "42",
          actual: null,
          error: "Execution failed with status tle_wall",
        },
        cases: [
          {
            caseId: "case-1",
            path: "cases/slow.json#0",
            status: "tle_wall",
            durationMs: 2001,
          },
        ],
      }),
    );
    expect(output.stdout.join("")).toContain("Input: [42]");
    expect(output.stdout.join("")).toContain("Expected: 42");
    expect(output.stdout.join("")).toContain(
      "Error: Execution failed with status tle_wall",
    );
    expect(output.stdout.join("")).not.toContain("Actual:");
  });

  it("writes precisely one envelope and no diagnostics in JSON mode", () => {
    const command = expectCommand(["test", "ok", "--json"]);
    const output = writers();
    renderOutcome(
      output.writers,
      "json",
      command,
      outcome("signaled", { target: "solution" }, [
        { code: "ignored", message: "not stderr" },
      ]),
    );
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        command: "test",
        correlationId: "correlation-1",
        status: "signaled",
        exitCode: 2,
      }),
    );
  });

  it("routes a command only to its selected composition handler", async () => {
    const command = expectCommand(["report"]);
    const calls: string[] = [];
    const handlers: CommandHandlers = {
      init: () => outcome("passed"),
      test: () => outcome("passed"),
      "stress-test": () => outcome("passed"),
      watch: () => outcome("passed"),
      benchmark: () => outcome("passed"),
      replay: () => outcome("passed"),
      report: () => {
        calls.push("report");
        return outcome("passed", { count: 0 });
      },
    };
    await expect(dispatchCommand(command, handlers)).resolves.toMatchObject({
      status: "passed",
    });
    expect(calls).toEqual(["report"]);
  });
});
