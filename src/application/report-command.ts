/**
 * Read-only run-history reporting application service.
 *
 * This module deliberately depends on a RunRepository, not a transaction
 * scope. Consequently it has no route by which to write, and a SQLite store
 * can bind the supplied repository to its query-only reader.
 */

import type {
  ExecutionStatus,
  PersistableRun,
  RunQuery,
} from "../domain/index.js";
import { isValidSlug } from "../infrastructure/problem.js";

/** Query values consumed independently of the CLI parser. */
export interface ReportInvocation {
  readonly slug?: string;
  /** Calendar date in YYYY-MM-DD form. */
  readonly since?: string;
}

/** JSON-safe stable projection of a persisted run. */
export interface ReportRun {
  readonly runId: string;
  readonly slug: string;
  readonly state: string;
  readonly status: ExecutionStatus;
  readonly seed: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly inputCodecVersion: string;
  readonly outputCodecVersion: string;
  readonly comparisonPolicyVersion: string;
  /** Benchmark comparability is present only for benchmark runs. */
  readonly benchmark: {
    readonly comparability: "comparable" | "non_comparable";
    readonly reason: string | null;
  } | null;
}

/** JSON-safe summary returned for both an empty and a populated report. */
export interface ReportCommandResult {
  readonly filters: {
    readonly slug: string | null;
    readonly since: string | null;
  };
  readonly runCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly runs: readonly ReportRun[];
}

export interface ReportDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface ReportApplicationOutcome {
  readonly status: "passed" | "invalid_input" | "internal_error";
  readonly result: ReportCommandResult | null;
  readonly diagnostics: readonly ReportDiagnostic[];
}

/** Read-only run history capability required by reporting. */
export interface ReportRunReader {
  list(query: RunQuery): AsyncIterable<PersistableRun>;
}

/** Report dependencies intentionally expose read access only. */
export interface ReportCommandDependencies {
  readonly runs: ReportRunReader;
}

/** Stream matching persisted runs into a stable, JSON-safe history summary. */
export async function executeReportCommand(
  invocation: ReportInvocation,
  dependencies: ReportCommandDependencies,
): Promise<ReportApplicationOutcome> {
  const validation = validate(invocation);
  if (validation !== null) {
    return failure("invalid_input", "invalid_report_filter", validation);
  }

  try {
    const runs: ReportRun[] = [];
    const counts: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    const since =
      invocation.since === undefined
        ? undefined
        : `${invocation.since}T00:00:00.000Z`;
    for await (const run of dependencies.runs.list({
      ...(invocation.slug === undefined ? {} : { slug: invocation.slug }),
      ...(since === undefined ? {} : { since }),
    })) {
      runs.push(project(run));
      counts[run.status] = (counts[run.status] ?? 0) + 1;
    }
    const statusCounts = Object.freeze(
      Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    );
    return Object.freeze({
      status: "passed",
      result: Object.freeze({
        filters: Object.freeze({
          slug: invocation.slug ?? null,
          since: invocation.since ?? null,
        }),
        runCount: runs.length,
        statusCounts,
        runs: Object.freeze(runs),
      }),
      diagnostics: Object.freeze([]),
    });
  } catch (error) {
    return failure("internal_error", "report_query_failed", messageOf(error));
  }
}

function validate(invocation: ReportInvocation): string | null {
  if (invocation.slug !== undefined && !isValidSlug(invocation.slug)) {
    return `invalid slug ${JSON.stringify(invocation.slug)}`;
  }
  if (invocation.since !== undefined && !isCalendarDate(invocation.since)) {
    return "--since must use a real YYYY-MM-DD calendar date";
  }
  return null;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function project(run: PersistableRun): ReportRun {
  return Object.freeze({
    runId: run.runId,
    slug: run.slug,
    state: run.state,
    status: run.status,
    seed: run.seed,
    startedAt: run.wallTimeUtc,
    durationMs: run.durationMs,
    inputCodecVersion: run.inputCodecVersion,
    outputCodecVersion: run.outputCodecVersion,
    comparisonPolicyVersion: run.comparisonPolicyVersion,
    benchmark:
      run.benchmark === undefined
        ? null
        : Object.freeze({
            comparability: run.benchmark.comparable
              ? "comparable"
              : "non_comparable",
            reason: run.benchmark.comparabilityReason,
          }),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unable to query run history";
}

function failure(
  status: "invalid_input" | "internal_error",
  code: string,
  message: string,
): ReportApplicationOutcome {
  return Object.freeze({
    status,
    result: null,
    diagnostics: Object.freeze([Object.freeze({ code, message })]),
  });
}
