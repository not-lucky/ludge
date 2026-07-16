/** CLI-owned rendering with strict one-envelope JSON output. */

import type { Command } from "./command.js";
import type { CliOutcome } from "./outcome.js";
import { toJsonEnvelope } from "./outcome.js";
import type { JsonValue } from "./types.js";

/** Minimal injectable writer seam for deterministic rendering tests. */
export interface CliWriters {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Render mode selected by a parsed command or parser-error scan. */
export type OutputMode = "human" | "json";

/**
 * Render one outcome. JSON mode performs exactly one write to stdout and never
 * writes to stderr; diagnostics remain inside its schema-v1 envelope. Human
 * mode is command-aware and concise: complete data remains available in JSON
 * output and persisted artifacts rather than becoming terminal noise.
 */
export function renderOutcome(
  writers: CliWriters,
  mode: OutputMode,
  command: Command | null,
  commandOutcome: CliOutcome,
): void {
  if (mode === "json") {
    writers.stdout(
      `${JSON.stringify(toJsonEnvelope(command, commandOutcome))}\n`,
    );
    return;
  }

  if (commandOutcome.result !== null) {
    writers.stdout(
      `${renderResult(command, commandOutcome.status, commandOutcome.result)}\n`,
    );
  } else {
    writers.stdout(`${commandOutcome.status}\n`);
  }
  for (const diagnostic of commandOutcome.diagnostics) {
    writers.stderr(`${diagnostic.code}: ${diagnostic.message}\n`);
  }
}

function renderResult(
  command: Command | null,
  status: string,
  result: NonNullable<CliOutcome["result"]>,
): string {
  if (typeof result === "string") return result;
  if (command?.name === "test" && isTestResult(result)) {
    const lines = [
      `Test ${status}: ${result.passedCaseCount}/${result.caseCount} passed`,
      `Run: ${result.runId}`,
    ];
    if (result.firstFailure !== null) {
      const failure = result.firstFailure;
      lines.push(
        `First failure: ${failure.path} (${failure.status}${failure.durationMs === null ? "" : `, ${failure.durationMs} ms`})`,
        `Input: ${failure.input}`,
        `Expected: ${failure.expected}`,
      );
      if (failure.actual !== null) lines.push(`Actual: ${failure.actual}`);
      if (failure.error !== null) lines.push(`Error: ${failure.error}`);
    }
    if (result.artifactId !== null)
      lines.push(`Artifact: ${result.artifactId}`);
    return lines.join("\n");
  }
  if (command?.name === "init" && isObject(result)) {
    return `Initialized ${text(result, "slug")}\nDirectory: ${text(result, "problemDirectory")}`;
  }
  if (command?.name === "report" && isObject(result)) {
    return `Report: ${number(result, "runCount")} run(s)\nStatuses: ${formatCounts(result.statusCounts)}`;
  }
  if (command?.name === "watch" && isObject(result)) {
    return `Watch ${text(result, "state")} for ${text(result, "slug")}`;
  }
  if (command?.name === "stress-test" && isObject(result)) {
    return `Stress test ${status}: ${number(result, "completedCases")} case(s) completed`;
  }
  if (command?.name === "benchmark" && isObject(result)) {
    return `Benchmark ${status}: ${number(result, "sampleCount")} sample(s) per implementation`;
  }
  if (command?.name === "replay" && isObject(result)) {
    return `Replay ${status}: ${text(result, "artifactId")} (${result.reproduced === true ? "reproduced" : "not reproduced"})`;
  }
  return JSON.stringify(result);
}

function isTestResult(value: JsonValue): value is {
  readonly runId: string;
  readonly caseCount: number;
  readonly passedCaseCount: number;
  readonly artifactId: string | null;
  readonly firstFailure: {
    readonly path: string;
    readonly status: string;
    readonly durationMs: number | null;
    readonly input: string;
    readonly expected: string;
    readonly actual: string | null;
    readonly error: string | null;
  } | null;
} {
  return (
    isObject(value) &&
    typeof value.runId === "string" &&
    typeof value.caseCount === "number" &&
    typeof value.passedCaseCount === "number" &&
    (value.artifactId === null || typeof value.artifactId === "string") &&
    (value.firstFailure === null ||
      (value.firstFailure !== undefined && isObject(value.firstFailure)))
  );
}
function isObject(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: Readonly<Record<string, JsonValue>>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "unknown";
}
function number(
  value: Readonly<Record<string, JsonValue>>,
  key: string,
): number {
  return typeof value[key] === "number" ? value[key] : 0;
}
function formatCounts(value: JsonValue | undefined): string {
  if (value === undefined || !isObject(value)) return "none";
  const parts = Object.entries(value).map(([key, count]) => `${key}=${count}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

/** Writers for the executable bootstrap; tests should inject an in-memory pair. */
export const processWriters: CliWriters = Object.freeze({
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
});
