import { describe, expect, it } from "vitest";

import { AppContext } from "../../../src/cli/context.js";
import { bootstrap } from "../../../src/cli/main.js";
import { outcome } from "../../../src/cli/outcome.js";
import type { CliWriters } from "../../../src/cli/output.js";
import type { ShutdownSignal } from "../../../src/cli/shutdown.js";

function memoryWriters(): {
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

function signalHarness(): {
  readonly register: (
    signal: ShutdownSignal,
    listener: () => void,
  ) => () => void;
  readonly emit: (signal: ShutdownSignal) => void;
} {
  const listeners = new Map<ShutdownSignal, () => void>();
  return {
    register: (signal, listener) => {
      listeners.set(signal, listener);
      return () => listeners.delete(signal);
    },
    emit: (signal) => listeners.get(signal)?.(),
  };
}

describe("bootstrap", () => {
  it("renders parser errors as one JSON envelope when --json was requested", async () => {
    const output = memoryWriters();
    const exitCode = await bootstrap(["test", "bad slug", "--json"], {
      writers: output.writers,
      parser: { createCorrelationId: () => "id" },
    });
    expect(exitCode).toBe(3);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      schemaVersion: 1,
      command: null,
      status: "invalid_input",
      exitCode: 3,
    });
  });

  it("contains handler failure as an internal structured outcome", async () => {
    const output = memoryWriters();
    const context = new AppContext({
      handlers: {
        init: () => outcome("passed"),
        test: () => {
          throw new Error("handler broke");
        },
        "stress-test": () => outcome("passed"),
        watch: () => outcome("passed"),
        benchmark: () => outcome("passed"),
        report: () => outcome("passed"),
        replay: () => outcome("passed"),
      },
    });
    const exitCode = await bootstrap(["test", "two-sum", "--json"], {
      writers: output.writers,
      createContext: () => context,
      parser: { createCorrelationId: () => "id" },
    });
    expect(exitCode).toBe(5);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      status: "internal_error",
      exitCode: 5,
    });
  });

  it("never reports a normal pass for an explicit unsafe-local command", async () => {
    const output = memoryWriters();
    const context = new AppContext({
      handlers: {
        init: () => outcome("passed"),
        test: () => outcome("passed", { cases: 1 }),
        "stress-test": () => outcome("passed"),
        watch: () => outcome("passed"),
        benchmark: () => outcome("passed"),
        report: () => outcome("passed"),
        replay: () => outcome("passed"),
      },
    });
    const exitCode = await bootstrap(
      ["test", "two-sum", "--unsafe-local", "--json"],
      {
        writers: output.writers,
        createContext: () => context,
        parser: { createCorrelationId: () => "id" },
      },
    );
    expect(exitCode).toBe(4);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      status: "sandbox_unsupported",
      exitCode: 4,
      result: { cases: 1 },
    });
  });

  it("cancels active dispatch, drains cleanup, and emits exit 130 rather than crashing", async () => {
    const output = memoryWriters();
    const signals = signalHarness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = new AppContext({
      handlers: {
        init: () => outcome("passed"),
        test: async () => {
          signals.emit("SIGINT");
          await pending;
          return outcome("passed");
        },
        "stress-test": () => outcome("passed"),
        watch: () => outcome("passed"),
        benchmark: () => outcome("passed"),
        report: () => outcome("passed"),
        replay: () => outcome("passed"),
      },
    });
    const run = bootstrap(["test", "two-sum", "--json"], {
      writers: output.writers,
      createContext: () => context,
      registerSignal: signals.register,
      parser: { createCorrelationId: () => "id" },
    });
    release();
    await expect(run).resolves.toBe(130);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      status: "canceled",
      exitCode: 130,
    });
  });
});
