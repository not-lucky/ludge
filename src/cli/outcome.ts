/** Structured CLI outcomes and their public exit-code/JSON contracts. */

import type { ExecutionStatus } from "../domain/status.js";
import type { CommandName, JsonValue } from "./types.js";
import { boundDiagnostic } from "./error.js";

/** Process exit codes defined by the CLI/configuration contract. */
export const ExitCode = {
  Ok: 0,
  Mismatch: 1,
  RuntimeFailure: 2,
  InvalidInput: 3,
  SandboxFailure: 4,
  InternalFailure: 5,
  Canceled: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** A bounded diagnostic intended for a human or a JSON client. */
export interface CliDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}

/** The complete structured result from parsing or handling a command. */
export interface CliOutcome<Result extends JsonValue = JsonValue> {
  readonly status: ExecutionStatus;
  readonly exitCode: ExitCode;
  readonly result: Result | null;
  readonly diagnostics: readonly CliDiagnostic[];
}

/** Command identity carried by a JSON envelope without exposing its options. */
export interface EnvelopeCommand {
  readonly name: CommandName;
  readonly correlationId: string;
}

/** Version 1 envelope emitted in JSON output mode. */
export interface CliJsonEnvelope<Result extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly command: CommandName | null;
  readonly correlationId: string | null;
  readonly status: ExecutionStatus;
  readonly exitCode: ExitCode;
  readonly result: Result | null;
  readonly diagnostics: readonly CliDiagnostic[];
}

/** Compute the contract exit code exclusively from the stable status literal. */
export function exitCodeForStatus(status: ExecutionStatus): ExitCode {
  switch (status) {
    case "passed":
      return ExitCode.Ok;
    case "wrong_answer":
      return ExitCode.Mismatch;
    case "nonzero_exit":
    case "signaled":
    case "tle_wall":
    case "tle_cpu":
    case "mle":
    case "output_limit":
    case "file_limit":
    case "process_limit":
    case "protocol_error":
      return ExitCode.RuntimeFailure;
    case "invalid_input":
      return ExitCode.InvalidInput;
    case "sandbox_unsupported":
    case "sandbox_error":
    case "spawn_error":
      return ExitCode.SandboxFailure;
    case "internal_error":
      return ExitCode.InternalFailure;
    case "canceled":
      return ExitCode.Canceled;
  }
}

/** Construct an immutable outcome and normalize user-visible diagnostic text. */
export function outcome<Result extends JsonValue>(
  status: ExecutionStatus,
  result: Result | null = null,
  diagnostics: readonly CliDiagnostic[] = [],
): CliOutcome<Result> {
  return Object.freeze({
    status,
    exitCode: exitCodeForStatus(status),
    result,
    diagnostics: Object.freeze(
      diagnostics.map((diagnostic) =>
        Object.freeze({ ...diagnostic, message: boundDiagnostic(diagnostic.message) }),
      ),
    ),
  });
}

/** A parser/bootstrap error represented through the normal outcome contract. */
export function invalidInputOutcome(
  message: string,
  code = "invalid_input",
): CliOutcome {
  return outcome("invalid_input", null, [{ code, message }]);
}

/** A bounded unexpected-failure outcome represented through the normal contract. */
export function internalErrorOutcome(
  message: string,
  code = "internal_error",
): CliOutcome {
  return outcome("internal_error", null, [{ code, message }]);
}

/**
 * Force the explicit unsafe-local label onto an affected command outcome.
 *
 * This guard belongs at the CLI dispatch boundary in addition to configuration
 * resolution so a newly added handler cannot accidentally claim a normal pass
 * without an enforcement boundary. Result data and diagnostics remain intact.
 */
export function labelUnsafeLocalOutcome<Result extends JsonValue>(
  unsafeLocal: boolean,
  commandOutcome: CliOutcome<Result>,
): CliOutcome<Result> {
  return unsafeLocal
    ? outcome("sandbox_unsupported", commandOutcome.result, commandOutcome.diagnostics)
    : commandOutcome;
}

/** Convert a command/outcome pair into the exact versioned JSON envelope. */
export type { JsonValue } from "./types.js";

export function toJsonEnvelope<Result extends JsonValue>(
  command: EnvelopeCommand | null,
  commandOutcome: CliOutcome<Result>,
): CliJsonEnvelope<Result> {
  return Object.freeze({
    schemaVersion: 1,
    command: command?.name ?? null,
    correlationId: command?.correlationId ?? null,
    status: commandOutcome.status,
    exitCode: commandOutcome.exitCode,
    result: commandOutcome.result,
    diagnostics: commandOutcome.diagnostics,
  });
}
