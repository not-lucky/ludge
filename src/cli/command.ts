/** Exact CLI command grammar, immutable command values, and handler seams. */

import { randomUUID } from "node:crypto";
import { isValidSlug } from "../infrastructure/problem.js";
import { invalidInput } from "./error.js";
import type { CliOutcome } from "./outcome.js";
import { invalidInputOutcome, outcome } from "./outcome.js";
import { COMMAND_NAMES, type CommandName } from "./types.js";

type CommandBase<Name extends CommandName, Options extends object> = Readonly<{
  readonly name: Name;
  readonly correlationId: string;
  readonly options: Readonly<Options>;
}>;

export type InitCommand = CommandBase<
  "init",
  { readonly slug: string; readonly json: boolean }
>;
export type TestCommand = CommandBase<
  "test",
  {
    readonly slug: string;
    readonly solution: string | undefined;
    readonly case: string | undefined;
    readonly jobs: number | undefined;
    readonly json: boolean;
    readonly unsafeLocal: boolean;
  }
>;
export type StressTestCommand = CommandBase<
  "stress-test",
  {
    readonly slug: string;
    readonly generator: string | undefined;
    readonly naive: string | undefined;
    readonly solution: string | undefined;
    /** Canonical decimal representation of a uint64 seed. */
    readonly seed: string | undefined;
    readonly cases: number | undefined;
    readonly duration: number | undefined;
    readonly jobs: number | undefined;
    readonly shrink: boolean;
    readonly json: boolean;
    readonly unsafeLocal: boolean;
  }
>;
export type WatchCommand = CommandBase<
  "watch",
  {
    readonly slug: string;
    readonly solution: string | undefined;
    readonly debounce: number | undefined;
    readonly jobs: number | undefined;
    readonly json: boolean;
    readonly unsafeLocal: boolean;
  }
>;
export type BenchmarkCommand = CommandBase<
  "benchmark",
  {
    readonly slug: string;
    readonly solutions: readonly string[];
    readonly cases: string | undefined;
    readonly warmup: number | undefined;
    readonly samples: number | undefined;
    readonly json: boolean;
    readonly unsafeLocal: boolean;
  }
>;
export type ReportCommand = CommandBase<
  "report",
  {
    readonly slug: string | undefined;
    readonly since: string | undefined;
    readonly json: boolean;
  }
>;
export type ReplayCommand = CommandBase<
  "replay",
  {
    readonly artifactId: string;
    readonly json: boolean;
    readonly unsafeLocal: boolean;
  }
>;

export type Command =
  | InitCommand
  | TestCommand
  | StressTestCommand
  | WatchCommand
  | BenchmarkCommand
  | ReportCommand
  | ReplayCommand;

export interface ParseSuccess {
  readonly ok: true;
  readonly command: Command;
}
export interface ParseFailure {
  readonly ok: false;
  readonly command: null;
  readonly json: boolean;
  readonly outcome: CliOutcome;
}
export type ParseResult = ParseSuccess | ParseFailure;

export interface ParseDependencies {
  /** Injectable only to make correlation IDs deterministic in unit tests. */
  readonly createCorrelationId?: () => string;
}

const UNSAFE_LOCAL_COMMANDS: ReadonlySet<CommandName> = new Set([
  "test",
  "stress-test",
  "watch",
  "benchmark",
  "replay",
]);
const MAX_SAFE_INTEGER_TEXT = BigInt(Number.MAX_SAFE_INTEGER);
const UINT64_MAX = (1n << 64n) - 1n;

const HELP_TEXT = `palestra — a local, extensible LeetCode-style judge

Usage: palestra <command> [options]

Commands:
  init <slug>             Scaffold a new problem directory
  test <slug>             Run test cases for a problem
  stress-test <slug>      Fuzz-test with generated cases
  watch <slug>            Re-run tests on file changes
  benchmark <slug>        Compare solution performance
  report [slug]           Show historical test results
  replay <artifact-id>    Re-run a recorded test artifact

Global options:
  --help                  Show this help message
  --json                  Emit output as a JSON envelope
  --unsafe-local          Skip sandbox enforcement (test, stress-test, watch, benchmark, replay)

Command options:
  init:
    --json                Emit the result as a JSON envelope

  test:
    --solution <path>     Path to solution file
    --case <path>         Path to a specific test-case file/group
    --jobs <n>            Parallel fixed-case worker count

  stress-test:
    --generator <path>    Path to input generator
    --naive <path>        Path to naive/brute-force solution
    --solution <path>     Path to solution file
    --seed <uint64>       Fixed RNG seed
    --cases <n>           Number of cases to generate
    --duration <seconds>  Time limit for the stress run
    --jobs <n>            Parallel worker count
    --shrink              Attempt to minimize failing input

  watch:
    --solution <path>     Path to solution file
    --debounce <ms>       Debounce interval in milliseconds
    --jobs <n>            Parallel fixed-case worker count per rerun

  benchmark:
    --solutions <a,b,...> Comma-separated solution paths (≥ 2)
    --cases <path>        Path to benchmark case set
    --warmup <n>          Warmup iterations (0 to skip)
    --samples <n>         Sample iterations per solution

  report:
    --since <YYYY-MM-DD>  Filter results after this date

  replay:
    (no additional options)`;

/**
 * Parse the documented grammar without using process state. All malformed input
 * is returned as an `invalid_input` outcome, never thrown to the bootstrap.
 */
export function parseCommand(
  argv: readonly string[],
  dependencies: ParseDependencies = {},
): ParseResult {
  const jsonRequested = argv.includes("--json");
  if (argv.includes("--help") || argv[0] === "help") {
    return Object.freeze({
      ok: false,
      command: null,
      json: jsonRequested,
      outcome: outcome("passed", HELP_TEXT),
    });
  }
  try {
    const unsafeIndexes = indexesOf(argv, "--unsafe-local");
    if (unsafeIndexes.length > 1) {
      throw invalidInput(
        "--unsafe-local may be supplied at most once",
        "duplicate_option",
      );
    }
    const withoutUnsafe = argv.filter((_, index) => index !== unsafeIndexes[0]);
    const rawName = withoutUnsafe[0];
    if (rawName === undefined) {
      throw invalidInput("a command is required", "missing_command");
    }
    if (!isCommandName(rawName)) {
      throw invalidInput(
        `unknown command ${JSON.stringify(rawName)}`,
        "unknown_command",
      );
    }
    const unsafeLocal = unsafeIndexes.length === 1;
    if (unsafeLocal && !UNSAFE_LOCAL_COMMANDS.has(rawName)) {
      throw invalidInput(
        `--unsafe-local is not accepted by ${rawName}`,
        "unsupported_option",
      );
    }

    const argumentsAfterCommand = withoutUnsafe.slice(1);
    const correlationId = dependencies.createCorrelationId ?? randomUUID;
    const command = parseNamedCommand(
      rawName,
      argumentsAfterCommand,
      unsafeLocal,
      correlationId(),
    );
    return Object.freeze({ ok: true, command });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "invalid command line";
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "invalid_input";
    return Object.freeze({
      ok: false,
      command: null,
      json: jsonRequested,
      outcome: invalidInputOutcome(message, code),
    });
  }
}

function parseNamedCommand(
  name: CommandName,
  values: readonly string[],
  unsafeLocal: boolean,
  correlationId: string,
): Command {
  switch (name) {
    case "init": {
      const parsed = parseArguments(values, new Set(["--json"]));
      return freezeCommand({
        name,
        correlationId,
        options: {
          slug: requiredSlug(parsed.positionals, name),
          json: parsed.flag("--json"),
        },
      });
    }
    case "test": {
      const parsed = parseArguments(
        values,
        new Set(["--solution", "--case", "--jobs", "--json"]),
      );
      return freezeCommand({
        name,
        correlationId,
        options: {
          slug: requiredSlug(parsed.positionals, name),
          solution: optionalPath(parsed.option("--solution"), "--solution"),
          case: optionalPath(parsed.option("--case"), "--case"),
          jobs: optionalPositiveInteger(parsed.option("--jobs"), "--jobs"),
          json: parsed.flag("--json"),
          unsafeLocal,
        },
      });
    }
    case "stress-test": {
      const parsed = parseArguments(
        values,
        new Set([
          "--generator",
          "--naive",
          "--solution",
          "--seed",
          "--cases",
          "--duration",
          "--jobs",
          "--shrink",
          "--json",
        ]),
      );
      return freezeCommand({
        name,
        correlationId,
        options: {
          slug: requiredSlug(parsed.positionals, name),
          generator: optionalPath(parsed.option("--generator"), "--generator"),
          naive: optionalPath(parsed.option("--naive"), "--naive"),
          solution: optionalPath(parsed.option("--solution"), "--solution"),
          seed: optionalUint64(parsed.option("--seed"), "--seed"),
          cases: optionalPositiveInteger(parsed.option("--cases"), "--cases"),
          duration: optionalPositiveInteger(
            parsed.option("--duration"),
            "--duration",
          ),
          jobs: optionalPositiveInteger(parsed.option("--jobs"), "--jobs"),
          shrink: parsed.flag("--shrink"),
          json: parsed.flag("--json"),
          unsafeLocal,
        },
      });
    }
    case "watch": {
      const parsed = parseArguments(
        values,
        new Set(["--solution", "--debounce", "--jobs", "--json"]),
      );
      return freezeCommand({
        name,
        correlationId,
        options: {
          slug: requiredSlug(parsed.positionals, name),
          solution: optionalPath(parsed.option("--solution"), "--solution"),
          debounce: optionalNonNegativeInteger(
            parsed.option("--debounce"),
            "--debounce",
          ),
          jobs: optionalPositiveInteger(parsed.option("--jobs"), "--jobs"),
          json: parsed.flag("--json"),
          unsafeLocal,
        },
      });
    }
    case "benchmark": {
      const parsed = parseArguments(
        values,
        new Set(["--solutions", "--cases", "--warmup", "--samples", "--json"]),
      );
      return freezeCommand({
        name,
        correlationId,
        options: {
          slug: requiredSlug(parsed.positionals, name),
          solutions: parseSolutions(parsed.requiredOption("--solutions")),
          cases: optionalPath(parsed.option("--cases"), "--cases"),
          warmup: optionalNonNegativeInteger(
            parsed.option("--warmup"),
            "--warmup",
          ),
          samples: optionalPositiveInteger(
            parsed.option("--samples"),
            "--samples",
          ),
          json: parsed.flag("--json"),
          unsafeLocal,
        },
      });
    }
    case "report": {
      const parsed = parseArguments(values, new Set(["--since", "--json"]));
      return freezeCommand({
        name,
        correlationId,
        options: {
          slug: optionalSlug(parsed.positionals, name),
          since: optionalDate(parsed.option("--since")),
          json: parsed.flag("--json"),
        },
      });
    }
    case "replay": {
      const parsed = parseArguments(values, new Set(["--json"]));
      return freezeCommand({
        name,
        correlationId,
        options: {
          artifactId: requiredText(parsed.positionals, "artifact-id"),
          json: parsed.flag("--json"),
          unsafeLocal,
        },
      });
    }
  }
}

class ParsedArguments {
  public constructor(
    public readonly positionals: readonly string[],
    private readonly options: ReadonlyMap<string, string | true>,
  ) {}
  public flag(name: string): boolean {
    return this.options.get(name) === true;
  }
  public option(name: string): string | undefined {
    const value = this.options.get(name);
    return typeof value === "string" ? value : undefined;
  }
  public requiredOption(name: string): string {
    const value = this.option(name);
    if (value === undefined)
      throw invalidInput(`${name} is required`, "missing_option");
    return value;
  }
}

function parseArguments(
  values: readonly string[],
  allowed: ReadonlySet<string>,
): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!allowed.has(value))
      throw invalidInput(
        `unknown option ${JSON.stringify(value)}`,
        "unknown_option",
      );
    if (options.has(value))
      throw invalidInput(
        `${value} may be supplied at most once`,
        "duplicate_option",
      );
    if (value === "--json" || value === "--shrink") {
      options.set(value, true);
      continue;
    }
    const optionValue = values[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw invalidInput(`${value} requires a value`, "missing_option_value");
    }
    options.set(value, optionValue);
    index += 1;
  }
  return new ParsedArguments(Object.freeze(positionals), options);
}

function requiredSlug(
  positionals: readonly string[],
  name: CommandName,
): string {
  if (positionals.length !== 1)
    throw invalidInput(
      `${name} requires exactly one <slug>`,
      "invalid_positional",
    );
  const slug = positionals[0]!;
  if (!isValidSlug(slug))
    throw invalidInput(`invalid slug ${JSON.stringify(slug)}`, "invalid_slug");
  return slug;
}
function optionalSlug(
  positionals: readonly string[],
  name: CommandName,
): string | undefined {
  if (positionals.length > 1)
    throw invalidInput(
      `${name} accepts at most one <slug>`,
      "invalid_positional",
    );
  if (positionals.length === 0) return undefined;
  return requiredSlug(positionals, name);
}
function requiredText(positionals: readonly string[], label: string): string {
  if (positionals.length !== 1)
    throw invalidInput(
      `replay requires exactly one <${label}>`,
      "invalid_positional",
    );
  return requiredNonEmpty(positionals[0]!, label);
}
function optionalPath(
  value: string | undefined,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requiredNonEmpty(value, label);
}
function requiredNonEmpty(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0"))
    throw invalidInput(
      `${label} must be non-empty and contain no NUL bytes`,
      "invalid_value",
    );
  return value;
}
function optionalUint64(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value))
    throw invalidInput(
      `${label} must be an unsigned decimal uint64`,
      "invalid_number",
    );
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX)
    throw invalidInput(`${label} exceeds uint64`, "number_out_of_range");
  return parsed.toString(10);
}
function optionalPositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  return optionalInteger(value, label, 1n);
}
function optionalNonNegativeInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  return optionalInteger(value, label, 0n);
}
function optionalInteger(
  value: string | undefined,
  label: string,
  minimum: bigint,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value))
    throw invalidInput(`${label} must be a decimal integer`, "invalid_number");
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > MAX_SAFE_INTEGER_TEXT)
    throw invalidInput(
      `${label} is outside the supported range`,
      "number_out_of_range",
    );
  return Number(parsed);
}
function optionalDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw invalidInput("--since must use YYYY-MM-DD", "invalid_date");
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw invalidInput("--since must be a real calendar date", "invalid_date");
  return value;
}
function parseSolutions(value: string): readonly string[] {
  const solutions = value.split(",");
  if (solutions.length < 2)
    throw invalidInput(
      "--solutions requires at least two comma-separated paths",
      "invalid_solutions",
    );
  return Object.freeze(
    solutions.map((solution) => requiredNonEmpty(solution, "--solutions")),
  );
}
function freezeCommand<
  CommandValue extends {
    readonly name: CommandName;
    readonly correlationId: string;
    readonly options: object;
  },
>(command: CommandValue): CommandValue {
  // Preserve the exact object type selected by each switch branch. Constraining
  // this helper to the union would widen optional properties under
  // `exactOptionalPropertyTypes` before the branch is returned.
  return Object.freeze({
    ...command,
    options: Object.freeze(command.options),
  }) as CommandValue;
}
function indexesOf(
  values: readonly string[],
  value: string,
): readonly number[] {
  return values.flatMap((candidate, index) =>
    candidate === value ? [index] : [],
  );
}
function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

/** A handler is intentionally JSON-result-only at the CLI boundary. */
export type CommandHandler<CommandValue extends Command = Command> = (
  command: CommandValue,
) => Promise<CliOutcome> | CliOutcome;
export type CommandHandlers = Readonly<{
  [Name in CommandName]: CommandHandler<
    Extract<Command, { readonly name: Name }>
  >;
}>;

/** Dispatch via the composition-supplied handler registry. */
export function dispatchCommand(
  command: Command,
  handlers: CommandHandlers,
): Promise<CliOutcome> {
  return Promise.resolve(handlers[command.name](command as never));
}

/** Default task-11 facade: commands are parsed but cannot claim implementation success. */
export function createDeferredCommandHandlers(): CommandHandlers {
  const deferred: CommandHandler = () =>
    outcome("internal_error", null, [
      {
        code: "command_deferred",
        message: "command implementation is not installed",
      },
    ]);
  return Object.freeze({
    init: deferred,
    test: deferred,
    "stress-test": deferred,
    watch: deferred,
    benchmark: deferred,
    report: deferred,
    replay: deferred,
  });
}

export { COMMAND_NAMES } from "./types.js";
export type { CommandName } from "./types.js";
