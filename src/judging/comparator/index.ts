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
import type { OutputComparator } from "../ports/index.js";
import { compareExactV1 } from "./exact-v1.js";
import { UnsupportedComparisonPolicyError } from "./errors.js";
import {
  EXACT_FAMILY,
  SUPPORTED_POLICY_MAJOR,
  parsePolicyVersion,
} from "./version.js";

/**
 * Create the version-dispatching {@link OutputComparator}.
 *
 * The comparator inspects `policy.version` on each call and throws
 * {@link UnsupportedComparisonPolicyError} for any unrecognized or
 * unsupported-major version; supported minors are accepted and migrated.
 *
 * @returns An output comparator over {@link CanonicalValue}.
 */
export function createOutputComparator(): OutputComparator<CanonicalValue> {
  return {
    compare(expected, actual, policy) {
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

// Concrete policy factory and its comparison function.
export { compareExactV1, createExactV1Comparator } from "./exact-v1.js";

// Version helpers.
export {
  EXACT_FAMILY,
  EXACT_V1_VERSION,
  SUPPORTED_POLICY_MAJOR,
  isSupportedPolicyVersion,
  parsePolicyVersion,
} from "./version.js";
export type { PolicyVersion } from "./version.js";

// Error type.
export { UnsupportedComparisonPolicyError } from "./errors.js";
