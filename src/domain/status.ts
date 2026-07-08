/**
 * Stable execution statuses and their normalization precedence.
 *
 * The literals and precedence tiers below are the normative set from
 * `docs/contracts/cli-and-configuration.md` (§ Stable execution statuses) and
 * `docs/architecture/execution-sandbox.md` (§ Status mapping). They are used by
 * the Chain-of-Responsibility status normalization: when a single execution
 * exhibits several failure signals at once, the highest-precedence cause wins.
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/**
 * Every stable execution status literal.
 *
 * A status is a machine outcome, never inferred from human-rendered text.
 */
export type ExecutionStatus =
  | "passed"
  | "wrong_answer"
  | "nonzero_exit"
  | "signaled"
  | "tle_wall"
  | "tle_cpu"
  | "mle"
  | "output_limit"
  | "file_limit"
  | "process_limit"
  | "protocol_error"
  | "invalid_input"
  | "spawn_error"
  | "sandbox_unsupported"
  | "sandbox_error"
  | "canceled"
  | "internal_error";

/**
 * The subset of {@link ExecutionStatus} literals that participate in
 * termination-cause precedence normalization.
 *
 * `invalid_input`, `canceled`, and `internal_error` are deliberately excluded:
 * they are classification statuses decided elsewhere (input validation, the run
 * state machine, and CLI/infrastructure faults respectively) rather than
 * competing termination causes for a single target execution.
 */
export type TerminationCause = Exclude<
  ExecutionStatus,
  "invalid_input" | "canceled" | "internal_error"
>;

/**
 * Termination causes grouped into precedence tiers, ordered highest severity
 * first. Statuses within the same inner array are equal in precedence.
 *
 * This is the single source of truth for status normalization ordering and
 * matches the spec exactly.
 */
export const EXECUTION_STATUS_PRECEDENCE: readonly (readonly TerminationCause[])[] =
  [
    ["sandbox_unsupported", "sandbox_error", "spawn_error"],
    [
      "tle_wall",
      "tle_cpu",
      "mle",
      "output_limit",
      "file_limit",
      "process_limit",
    ],
    ["protocol_error"],
    ["signaled"],
    ["nonzero_exit"],
    ["wrong_answer"],
    ["passed"],
  ] as const;

/**
 * Rank of each termination cause, where a smaller number means higher severity
 * (tier 0 is the most severe). Precomputed from
 * {@link EXECUTION_STATUS_PRECEDENCE}.
 */
const SEVERITY_RANK: ReadonlyMap<TerminationCause, number> = new Map(
  EXECUTION_STATUS_PRECEDENCE.flatMap((tier, index) =>
    tier.map((status) => [status, index] as const),
  ),
);

/**
 * Report whether a status participates in termination-cause precedence.
 *
 * @param status - Any execution status.
 * @returns `true` when `status` is a {@link TerminationCause}.
 */
export function isTerminationCause(
  status: ExecutionStatus,
): status is TerminationCause {
  return SEVERITY_RANK.has(status as TerminationCause);
}

/**
 * Severity rank of a termination cause: `0` is most severe, larger is less
 * severe (with `passed` being the least severe).
 *
 * @param status - The termination cause to rank.
 * @returns The precedence tier index of `status`.
 */
export function statusSeverityRank(status: TerminationCause): number {
  // Every TerminationCause is present in the map by construction.
  return SEVERITY_RANK.get(status)!;
}

/**
 * Compare two termination causes by precedence.
 *
 * @param a - First termination cause.
 * @param b - Second termination cause.
 * @returns A negative number when `a` is more severe than `b`, positive when
 *   less severe, and `0` when they share a precedence tier. The sign follows the
 *   usual comparator convention ordering most-severe-first.
 */
export function compareStatusPrecedence(
  a: TerminationCause,
  b: TerminationCause,
): number {
  return statusSeverityRank(a) - statusSeverityRank(b);
}

/**
 * Select the highest-precedence (most severe) termination cause from the
 * observed causes of a single execution.
 *
 * @param first - At least one observed termination cause is required.
 * @param rest - Any additional observed causes.
 * @returns The most severe cause; ties resolve to the earliest argument, which
 *   is irrelevant since same-tier causes are equivalent.
 */
export function mostSevere(
  first: TerminationCause,
  ...rest: readonly TerminationCause[]
): TerminationCause {
  let winner = first;
  for (const candidate of rest) {
    if (compareStatusPrecedence(candidate, winner) < 0) {
      winner = candidate;
    }
  }
  return winner;
}
