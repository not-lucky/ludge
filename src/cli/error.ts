/** Bounded errors translated into structured CLI outcomes. */

/** Maximum diagnostic message length retained from user-controlled input. */
export const MAX_CLI_DIAGNOSTIC_LENGTH = 1_024;

/** Error categories that can cross the CLI bootstrap boundary. */
export type CliErrorKind = "invalid_input" | "internal_error";

/**
 * A safe, user-facing CLI error. Its text is intentionally bounded so malformed
 * input cannot turn diagnostics or JSON envelopes into unbounded output.
 */
export class CliError extends Error {
  public constructor(
    public readonly kind: CliErrorKind,
    message: string,
    public readonly code: string = kind,
  ) {
    super(boundDiagnostic(message));
    this.name = "CliError";
  }
}

/** Create an error caused by malformed command-line input. */
export function invalidInput(message: string, code = "invalid_input"): CliError {
  return new CliError("invalid_input", message, code);
}

/**
 * Normalize an unknown thrown value without exposing stack traces or arbitrary
 * objects in the command result.
 */
export function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof Error) {
    return new CliError("internal_error", error.message, "internal_error");
  }
  return new CliError("internal_error", "an unexpected CLI failure occurred", "internal_error");
}

/** Bound text while preserving a deterministic indication of truncation. */
export function boundDiagnostic(value: string): string {
  if (value.length <= MAX_CLI_DIAGNOSTIC_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_CLI_DIAGNOSTIC_LENGTH - 16)}...[truncated]`;
}
