/** CLI-owned rendering with strict one-envelope JSON output. */

import type { Command } from "./command.js";
import type { CliOutcome } from "./outcome.js";
import { toJsonEnvelope } from "./outcome.js";

/** Minimal injectable writer seam for deterministic rendering tests. */
export interface CliWriters {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Render mode selected by a parsed command or parser-error scan. */
export type OutputMode = "human" | "json";

/**
 * Render one outcome. JSON mode performs exactly one write to stdout and never
 * writes to stderr; diagnostics remain inside its schema-v1 envelope.
 */
export function renderOutcome(
  writers: CliWriters,
  mode: OutputMode,
  command: Command | null,
  commandOutcome: CliOutcome,
): void {
  if (mode === "json") {
    writers.stdout(`${JSON.stringify(toJsonEnvelope(command, commandOutcome))}\n`);
    return;
  }

  if (commandOutcome.result !== null) {
    writers.stdout(`${renderResult(commandOutcome.result)}\n`);
  } else {
    // A concise machine-status literal is the human summary. Explanatory
    // details remain diagnostics on stderr and are never used to infer status.
    writers.stdout(`${commandOutcome.status}\n`);
  }
  for (const diagnostic of commandOutcome.diagnostics) {
    writers.stderr(`${diagnostic.code}: ${diagnostic.message}\n`);
  }
}

function renderResult(result: NonNullable<CliOutcome["result"]>): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** Writers for the executable bootstrap; tests should inject an in-memory pair. */
export const processWriters: CliWriters = Object.freeze({
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
});
