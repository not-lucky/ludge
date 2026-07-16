import { describe, it, expect } from "vitest";
import {
  compareStatusPrecedence,
  EXECUTION_STATUS_PRECEDENCE,
  isTerminationCause,
  mostSevere,
  statusSeverityRank,
} from "../../../src/domain/status.js";
import type {
  ExecutionStatus,
  TerminationCause,
} from "../../../src/domain/status.js";

/**
 * The full set of stable execution status literals from
 * docs/contracts/cli-and-configuration.md (§ Stable execution statuses).
 */
const ALL_STATUSES: readonly ExecutionStatus[] = [
  "passed",
  "wrong_answer",
  "nonzero_exit",
  "signaled",
  "tle_wall",
  "tle_cpu",
  "mle",
  "output_limit",
  "file_limit",
  "process_limit",
  "protocol_error",
  "invalid_input",
  "spawn_error",
  "sandbox_unsupported",
  "sandbox_error",
  "canceled",
  "internal_error",
];

/** Statuses excluded from termination-cause precedence normalization. */
const NON_TERMINATION_STATUSES: readonly ExecutionStatus[] = [
  "invalid_input",
  "canceled",
  "internal_error",
];

/** The 14 termination causes, i.e. all statuses minus the excluded three. */
const TERMINATION_CAUSES: readonly TerminationCause[] = [
  "sandbox_unsupported",
  "sandbox_error",
  "spawn_error",
  "tle_wall",
  "tle_cpu",
  "mle",
  "output_limit",
  "file_limit",
  "process_limit",
  "protocol_error",
  "signaled",
  "nonzero_exit",
  "wrong_answer",
  "passed",
];

/**
 * The expected precedence tiers, highest severity first, copied verbatim from
 * the spec so the test acts as an independent oracle rather than mirroring the
 * source structure by reference.
 */
const EXPECTED_TIERS: readonly (readonly TerminationCause[])[] = [
  ["sandbox_unsupported", "sandbox_error", "spawn_error"],
  ["tle_wall", "tle_cpu", "mle", "output_limit", "file_limit", "process_limit"],
  ["protocol_error"],
  ["signaled"],
  ["nonzero_exit"],
  ["wrong_answer"],
  ["passed"],
];

describe("ExecutionStatus literals", () => {
  it("contains exactly the 17 spec literals", () => {
    expect(new Set(ALL_STATUSES).size).toBe(17);
    expect([...ALL_STATUSES].sort()).toEqual(
      [...TERMINATION_CAUSES, ...NON_TERMINATION_STATUSES].sort(),
    );
  });
});

describe("EXECUTION_STATUS_PRECEDENCE", () => {
  it("matches the spec tiers exactly in order and membership", () => {
    // Structural deep equality: order of tiers and order within tiers.
    expect(EXECUTION_STATUS_PRECEDENCE).toEqual(EXPECTED_TIERS);
  });

  it("has 7 tiers", () => {
    expect(EXECUTION_STATUS_PRECEDENCE).toHaveLength(7);
  });

  it("covers every termination cause exactly once and none of the excluded statuses", () => {
    const flattened = EXECUTION_STATUS_PRECEDENCE.flat();
    expect(flattened).toHaveLength(14);
    expect(new Set(flattened).size).toBe(14);
    expect([...flattened].sort()).toEqual([...TERMINATION_CAUSES].sort());
    for (const excluded of NON_TERMINATION_STATUSES) {
      expect(flattened).not.toContain(excluded);
    }
  });
});

describe("statusSeverityRank", () => {
  it("assigns tier 0 (most severe) to the first tier's statuses", () => {
    for (const status of EXPECTED_TIERS[0]) {
      expect(statusSeverityRank(status)).toBe(0);
    }
  });

  it("assigns the tier index as the rank for each status", () => {
    EXPECTED_TIERS.forEach((tier, tierIndex) => {
      for (const status of tier) {
        expect(statusSeverityRank(status)).toBe(tierIndex);
      }
    });
  });

  it("gives same-tier statuses an identical rank", () => {
    for (const tier of EXPECTED_TIERS) {
      const ranks = tier.map((status) => statusSeverityRank(status));
      const [first] = ranks;
      expect(ranks.every((rank) => rank === first)).toBe(true);
    }
  });

  it("ranks increase monotonically down the tiers", () => {
    const tierRanks = EXPECTED_TIERS.map((tier) => statusSeverityRank(tier[0]));
    for (let i = 1; i < tierRanks.length; i += 1) {
      expect(tierRanks[i]).toBeGreaterThan(tierRanks[i - 1]);
    }
  });

  it("gives passed the largest (least severe) rank", () => {
    const passedRank = statusSeverityRank("passed");
    for (const status of TERMINATION_CAUSES) {
      if (status !== "passed") {
        expect(passedRank).toBeGreaterThan(statusSeverityRank(status));
      }
    }
    expect(passedRank).toBe(EXPECTED_TIERS.length - 1);
  });
});

describe("compareStatusPrecedence", () => {
  it("returns a negative number when the first arg is more severe", () => {
    expect(compareStatusPrecedence("sandbox_error", "passed")).toBeLessThan(0);
    expect(compareStatusPrecedence("mle", "wrong_answer")).toBeLessThan(0);
    expect(compareStatusPrecedence("protocol_error", "signaled")).toBeLessThan(
      0,
    );
  });

  it("returns a positive number when the first arg is less severe", () => {
    expect(compareStatusPrecedence("wrong_answer", "mle")).toBeGreaterThan(0);
    expect(compareStatusPrecedence("passed", "sandbox_error")).toBeGreaterThan(
      0,
    );
    expect(compareStatusPrecedence("nonzero_exit", "signaled")).toBeGreaterThan(
      0,
    );
  });

  it("returns 0 for statuses sharing a precedence tier", () => {
    expect(compareStatusPrecedence("tle_wall", "mle")).toBe(0);
    expect(compareStatusPrecedence("sandbox_unsupported", "spawn_error")).toBe(
      0,
    );
    expect(compareStatusPrecedence("passed", "passed")).toBe(0);
  });

  it("is antisymmetric in sign for cross-tier pairs", () => {
    expect(Math.sign(compareStatusPrecedence("sandbox_error", "passed"))).toBe(
      -Math.sign(compareStatusPrecedence("passed", "sandbox_error")),
    );
  });
});

describe("mostSevere", () => {
  it("returns the single argument when given only one", () => {
    for (const status of TERMINATION_CAUSES) {
      expect(mostSevere(status)).toBe(status);
    }
  });

  it("picks the highest-severity cause from a mixed list", () => {
    expect(mostSevere("passed", "wrong_answer", "mle", "nonzero_exit")).toBe(
      "mle",
    );
    expect(
      mostSevere("wrong_answer", "signaled", "sandbox_error", "protocol_error"),
    ).toBe("sandbox_error");
  });

  it("is independent of argument order", () => {
    expect(mostSevere("passed", "mle", "wrong_answer")).toBe("mle");
    expect(mostSevere("mle", "wrong_answer", "passed")).toBe("mle");
    expect(mostSevere("wrong_answer", "passed", "mle")).toBe("mle");
  });

  it("resolves ties to an equal-precedence result (same tier as the tied inputs)", () => {
    const result = mostSevere("tle_wall", "mle", "output_limit");
    // The winner must sit in the shared tier, not necessarily a specific literal.
    expect(statusSeverityRank(result)).toBe(statusSeverityRank("tle_wall"));
    expect(compareStatusPrecedence(result, "mle")).toBe(0);
  });

  it("keeps the top-tier cause even when combined with the least severe", () => {
    expect(mostSevere("passed", "spawn_error")).toBe("spawn_error");
    expect(mostSevere("spawn_error", "passed")).toBe("spawn_error");
  });
});

describe("isTerminationCause", () => {
  it.each(TERMINATION_CAUSES)(
    "returns true for termination cause %s",
    (status) => {
      expect(isTerminationCause(status)).toBe(true);
    },
  );

  it.each(NON_TERMINATION_STATUSES)(
    "returns false for non-termination status %s",
    (status) => {
      expect(isTerminationCause(status)).toBe(false);
    },
  );

  it("classifies all 14 termination causes as true", () => {
    const trueCount = ALL_STATUSES.filter((status) =>
      isTerminationCause(status),
    ).length;
    expect(trueCount).toBe(14);
  });
});
