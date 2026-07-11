/**
 * The `exact-v1` comparison policy.
 *
 * `exact-v1` is the default judging policy. It supports two equality modes:
 *
 * - `semantic` (the default): structural equality of decoded values, with the
 *   optional numeric tolerance and text whitespace normalization implemented in
 *   `./semantic.ts`.
 * - `canonical_bytes`: an explicit opt-in that requires the two values to share
 *   the exact canonical wire form. This is the strictest mode; a tolerance or
 *   whitespace flag has no effect on it.
 *
 * The comparator consumes already-decoded {@link CanonicalValue}s and a
 * {@link ComparisonPolicy}; it never re-parses wire bytes. Timing, cap, and
 * telemetry decorators around the sandbox do not reach this seam, so comparison
 * outcome is independent of runtime mechanics.
 */

import type { CanonicalValue } from "../value/model.js";
import type { OutputComparator } from "../ports/index.js";
import type {
  ComparisonPolicy,
  ComparisonResult,
} from "../../domain/index.js";
import { canonicalStringOf } from "../codec/encode.js";
import { renderValue } from "./render.js";
import { semanticMismatch } from "./semantic.js";

/**
 * Compare two decoded values under the `exact-v1` policy.
 *
 * @param expected - The reference value (from a case/oracle).
 * @param actual - The value produced by the target implementation.
 * @param policy - The `exact-v1` policy selecting the equality mode.
 * @returns Equality, or the first mismatch found.
 */
export function compareExactV1(
  expected: CanonicalValue,
  actual: CanonicalValue,
  policy: ComparisonPolicy,
): ComparisonResult {
  if (policy.equality === "canonical_bytes") {
    return compareCanonicalBytes(expected, actual);
  }
  const found = semanticMismatch(expected, actual, policy, "$");
  return found === null ? { equal: true } : { equal: false, mismatch: found };
}

/**
 * Create an {@link OutputComparator} that applies the `exact-v1` policy.
 *
 * The returned comparator does not itself validate the policy version; version
 * dispatch (rejecting unsupported majors) is the responsibility of the
 * `createOutputComparator` façade in `./index.ts`.
 *
 * @returns An `exact-v1` output comparator over {@link CanonicalValue}.
 */
export function createExactV1Comparator(): OutputComparator<CanonicalValue> {
  return { compare: compareExactV1 };
}

/** Compare two values by their exact canonical bytes. */
function compareCanonicalBytes(
  expected: CanonicalValue,
  actual: CanonicalValue,
): ComparisonResult {
  if (canonicalStringOf(expected) === canonicalStringOf(actual)) {
    return { equal: true };
  }
  return {
    equal: false,
    mismatch: {
      path: "$",
      reason: "canonical bytes differ",
      expected: renderValue(expected),
      actual: renderValue(actual),
    },
  };
}
