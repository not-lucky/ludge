#!/usr/bin/env node
/**
 * Palestra Judge command-line entry point and composition root.
 *
 * This module is the ONLY place in the codebase permitted to select concrete
 * factories (runtime adapters, sandbox, codec, repositories, telemetry). Every
 * other layer depends on ports and domain contracts, never on concrete
 * implementations. Keeping the wiring here preserves the layered dependency
 * direction enforced by `.dependency-cruiser.cjs`.
 *
 * At this scaffolding stage it does nothing but print usage and exit; real
 * command dispatch and adapter wiring arrive in later tasks (the CLI framework
 * in task 11 and the individual command use cases thereafter).
 */

/** Process exit codes used by the CLI (see the CLI/configuration contract). */
const ExitCode = {
  /** Successful invocation, including help/usage output. */
  Ok: 0,
  /** Usage error: unknown command or malformed arguments (sysexits `EX_USAGE`). */
  Usage: 64,
} as const;

/** Human-readable usage banner printed for `--help` and unknown commands. */
const USAGE = `palestra — a local, extensible LeetCode-style judge

Usage:
  palestra <command> [options]

Commands:
  (none yet — command dispatch is implemented in later tasks)

Options:
  -h, --help       Show this help and exit
  -v, --version    Print the version and exit

This is a scaffolding build: no judging commands are wired up yet.
`;

/**
 * Parse argv and print the appropriate banner.
 *
 * @param argv - Command-line arguments with the node and script paths removed.
 * @returns The process exit code to use.
 */
export function run(argv: readonly string[]): number {
  const [command] = argv;

  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return ExitCode.Ok;
  }

  if (command === "-v" || command === "--version") {
    process.stdout.write("palestra 0.1.0\n");
    return ExitCode.Ok;
  }

  process.stderr.write(`palestra: unknown command '${command}'\n\n`);
  process.stderr.write(USAGE);
  return ExitCode.Usage;
}

process.exitCode = run(process.argv.slice(2));
