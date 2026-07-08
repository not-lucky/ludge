/**
 * Output comparator port.
 *
 * An {@link OutputComparator} decides whether an actual decoded value equals an
 * expected decoded value under a versioned {@link ComparisonPolicy}. It is the
 * Strategy seam of the judging layer: comparators are injectable and
 * independently testable, and they consume already-decoded values plus a policy
 * — never raw bytes and never human-rendered text.
 *
 * This module is pure: it declares a contract only and imports no runtime,
 * adapter, or Node module (only domain value types).
 */

import type { ComparisonPolicy, ComparisonResult } from "../../domain/index.js";

/**
 * Compares two decoded canonical values under a comparison policy.
 *
 * The concrete comparators live in the judging layer (task 05); a codec failure
 * is `protocol_error` and a semantic mismatch is `wrong_answer`, but those
 * classifications happen in the application layer — the comparator only reports
 * structural/semantic (in)equality via {@link ComparisonResult}.
 *
 * @typeParam TValue - The canonical value model being compared (task 04).
 */
export interface OutputComparator<TValue> {
  /**
   * Compare an expected value against an actual value under `policy`.
   *
   * @param expected - The reference value (from a case/oracle).
   * @param actual - The value produced by the target implementation.
   * @param policy - The versioned equality/tolerance policy to apply.
   * @returns Equality, or the first mismatch found.
   */
  compare(
    expected: TValue,
    actual: TValue,
    policy: ComparisonPolicy,
  ): ComparisonResult;
}
