/**
 * Public surface of the judging comparators.
 *
 * {@link createOutputComparator} is the version-dispatching façade: it parses a
 * {@link ComparisonPolicy}'s version, rejects unsupported majors (accepting any
 * supported minor), and routes to the matching concrete comparator. Today the
 * only family/major is `exact-v1`, so dispatch resolves to
 * {@link compareExactV1}; adding a future policy means registering another
 * major here without disturbing existing behavior (Bridge: policy varies
 * independently from runtime mechanics).
 *
 * Internal helpers (the semantic walk, tolerance math, and rendering) are not
 * re-exported: callers depend on the {@link OutputComparator} port surface.
 */

import type { CanonicalValue } from "./../value/model.js";
import type { ComparisonPolicy } from "../../domain/comparison.js";
import { compareExactV1 } from "./exact-v1.js";
import { UnsupportedComparisonPolicyError } from "./errors.js";
import {
  EXACT_FAMILY,
  SUPPORTED_POLICY_MAJOR,
  parsePolicyVersion,
} from "./version.js";

export const EXACT_V1_VERSION = "exact-v1";

export function createOutputComparator() {
  return {
    compare(
      expected: CanonicalValue,
      actual: CanonicalValue,
      policy: ComparisonPolicy,
    ) {
      const parsed = parsePolicyVersion(policy.version);
      if (
        parsed === null ||
        parsed.family !== EXACT_FAMILY ||
        parsed.major !== SUPPORTED_POLICY_MAJOR
      ) {
        throw new UnsupportedComparisonPolicyError(policy.version);
      }
      return compareExactV1(expected, actual, policy);
    },
  };
}

export { compareExactV1, createExactV1Comparator } from "./exact-v1.js";
export {
  EXACT_FAMILY,
  SUPPORTED_POLICY_MAJOR,
  isSupportedPolicyVersion,
  parsePolicyVersion,
} from "./version.js";
export { UnsupportedComparisonPolicyError } from "./errors.js";
