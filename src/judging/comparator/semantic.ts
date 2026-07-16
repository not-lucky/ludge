/**
 * Semantic equality with per-problem numeric tolerance and text whitespace
 * normalization — the algorithm behind the `exact-v1` policy.
 *
 * The comparison walks two *decoded* {@link CanonicalValue}s in lock-step and
 * returns the first {@link ComparisonMismatch}, or `null` when the values are
 * judged equal. It reasons about decoded values only and never touches wire
 * bytes.
 *
 * Design invariants enforced here (see
 * `docs/contracts/value-model-and-protocol.md`):
 *
 * - Equality is exact and tag-sensitive by default. A tolerance never changes
 *   the *type* of a leaf: two leaves with different tags are always a mismatch.
 * - {@link ComparisonPolicy.tolerance}, when present, relaxes only finite
 *   `float`/`decimal` value comparison (and, via recursion, the `float`/`decimal`
 *   parts of a `complex`). It never relaxes `int`, `str`, container shape (length
 *   and keys), or `exception` semantics.
 * - {@link ComparisonPolicy.normalizeWhitespace}, when set, applies only to
 *   `str` leaves — the text type — and never to any other leaf.
 *
 * Ordering note: `set`, `frozenset`, and `dict` arrive already sorted by
 * canonical bytes from the codec, so equal collections align positionally and
 * are compared element/entry-wise. Dict keys and exception values are compared
 * by their canonical bytes so a tolerance can never loosen them.
 *
 * This module lives in the judging layer; it imports the value model, the
 * sibling codec encoder (for byte-exact sub-comparisons and diagnostics), and
 * domain result types only.
 */

import type { CanonicalValue, DictEntry, RecordField } from "../value/model.js";
import type {
  ComparisonMismatch,
  ComparisonPolicy,
  NumericTolerance,
} from "../../domain/index.js";
import { canonicalStringOf } from "../codec/encode.js";
import { renderValue } from "./render.js";

/** Sentinel meaning "values are equal" (no mismatch found). */
type MaybeMismatch = ComparisonMismatch | null;

/**
 * Compute the first semantic mismatch between two decoded canonical values.
 *
 * @param expected - The reference value (from a case/oracle).
 * @param actual - The value produced by the target implementation.
 * @param policy - The versioned equality/tolerance policy to apply.
 * @param path - Canonical path of the current node (start at `"$"`).
 * @returns The first mismatch found, or `null` if the values are equal.
 */
export function semanticMismatch(
  expected: CanonicalValue,
  actual: CanonicalValue,
  policy: ComparisonPolicy,
  path: string,
): MaybeMismatch {
  if (expected.tag !== actual.tag) {
    return mismatch(path, "tag differs", expected, actual);
  }

  switch (expected.tag) {
    case "null":
      return null;

    case "bool": {
      const a = actual as Extract<CanonicalValue, { tag: "bool" }>;
      return expected.value === a.value
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "int": {
      // Integer equality is always exact; tolerance never relaxes it.
      const a = actual as Extract<CanonicalValue, { tag: "int" }>;
      return expected.value === a.value
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "float": {
      const a = actual as Extract<CanonicalValue, { tag: "float" }>;
      if (policy.tolerance !== undefined) {
        return withinTolerance(
          Number(expected.value),
          Number(a.value),
          policy.tolerance,
        )
          ? null
          : mismatch(path, "float outside tolerance", expected, actual);
      }
      // Exact: canonical text and the negative-zero flag must both match.
      return expected.value === a.value &&
        expected.negativeZero === a.negativeZero
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "decimal": {
      const a = actual as Extract<CanonicalValue, { tag: "decimal" }>;
      if (policy.tolerance !== undefined) {
        return withinTolerance(
          Number(expected.value),
          Number(a.value),
          policy.tolerance,
        )
          ? null
          : mismatch(path, "decimal outside tolerance", expected, actual);
      }
      return expected.value === a.value
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "complex": {
      const a = actual as Extract<CanonicalValue, { tag: "complex" }>;
      return (
        semanticMismatch(expected.real, a.real, policy, `${path}.real`) ??
        semanticMismatch(expected.imag, a.imag, policy, `${path}.imag`)
      );
    }

    case "str": {
      const a = actual as Extract<CanonicalValue, { tag: "str" }>;
      const equal = policy.normalizeWhitespace
        ? normalizeWhitespace(expected.value) === normalizeWhitespace(a.value)
        : expected.value === a.value;
      return equal ? null : mismatch(path, "text differs", expected, actual);
    }

    case "list":
    case "tuple": {
      const a = actual as Extract<CanonicalValue, { tag: "list" | "tuple" }>;
      return sequenceMismatch(
        expected.items,
        a.items,
        policy,
        path,
        expected,
        actual,
      );
    }

    case "set":
    case "frozenset": {
      const a = actual as Extract<CanonicalValue, { tag: "set" | "frozenset" }>;
      return sequenceMismatch(
        expected.items,
        a.items,
        policy,
        path,
        expected,
        actual,
      );
    }

    case "dict": {
      const a = actual as Extract<CanonicalValue, { tag: "dict" }>;
      return dictMismatch(
        expected.entries,
        a.entries,
        policy,
        path,
        expected,
        actual,
      );
    }

    case "bytes": {
      const a = actual as Extract<CanonicalValue, { tag: "bytes" }>;
      return expected.encoding === a.encoding && expected.value === a.value
        ? null
        : mismatch(path, "bytes differ", expected, actual);
    }

    case "date":
    case "uuid": {
      const a = actual as Extract<CanonicalValue, { tag: "date" | "uuid" }>;
      return expected.value === a.value
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "time": {
      const a = actual as Extract<CanonicalValue, { tag: "time" }>;
      return expected.value === a.value &&
        expected.offsetMinutes === a.offsetMinutes &&
        expected.fold === a.fold
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "datetime": {
      const a = actual as Extract<CanonicalValue, { tag: "datetime" }>;
      return expected.value === a.value &&
        expected.offsetMinutes === a.offsetMinutes &&
        expected.fold === a.fold
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "path": {
      const a = actual as Extract<CanonicalValue, { tag: "path" }>;
      return expected.value === a.value && expected.flavor === a.flavor
        ? null
        : mismatch(path, "value differs", expected, actual);
    }

    case "enum": {
      const a = actual as Extract<CanonicalValue, { tag: "enum" }>;
      if (expected.type !== a.type || expected.member !== a.member) {
        return mismatch(path, "enum identity differs", expected, actual);
      }
      return semanticMismatch(expected.value, a.value, policy, `${path}.value`);
    }

    case "record": {
      const a = actual as Extract<CanonicalValue, { tag: "record" }>;
      if (expected.type !== a.type || expected.name !== a.name) {
        return mismatch(path, "record identity differs", expected, actual);
      }
      return recordMismatch(
        expected.fields,
        a.fields,
        policy,
        path,
        expected,
        actual,
      );
    }

    case "exception": {
      // Exceptions are compared exactly by canonical bytes so no tolerance can
      // loosen their type, message, or details.
      const a = actual as Extract<CanonicalValue, { tag: "exception" }>;
      return canonicalStringOf(expected) === canonicalStringOf(a)
        ? null
        : mismatch(path, "exception differs", expected, actual);
    }

    case "ListNode": {
      const a = actual as Extract<CanonicalValue, { tag: "ListNode" }>;
      if (expected.cycleIndex !== a.cycleIndex) {
        return mismatch(path, "cycleIndex differs", expected, actual);
      }
      if (expected.values.length !== a.values.length) {
        return mismatch(path, "length differs", expected, actual);
      }
      return itemsMismatch(expected.values, a.values, policy, `${path}.values`);
    }

    case "TreeNode": {
      const a = actual as Extract<CanonicalValue, { tag: "TreeNode" }>;
      return treeNodeMismatch(
        expected.values,
        a.values,
        policy,
        path,
        expected,
        actual,
      );
    }

    case "ClassTrace": {
      const a = actual as Extract<CanonicalValue, { tag: "ClassTrace" }>;
      return classTraceMismatch(expected, a, policy, path);
    }
  }
}

/** Compare two ordered item sequences (`list`/`tuple`/`set`/`frozenset`). */
function sequenceMismatch(
  expected: readonly CanonicalValue[],
  actual: readonly CanonicalValue[],
  policy: ComparisonPolicy,
  path: string,
  expectedNode: CanonicalValue,
  actualNode: CanonicalValue,
): MaybeMismatch {
  if (expected.length !== actual.length) {
    return mismatch(path, "length differs", expectedNode, actualNode);
  }
  return itemsMismatch(expected, actual, policy, `${path}.items`);
}

/** Recurse element-wise over two equal-length item arrays. */
function itemsMismatch(
  expected: readonly CanonicalValue[],
  actual: readonly CanonicalValue[],
  policy: ComparisonPolicy,
  basePath: string,
): MaybeMismatch {
  for (let i = 0; i < expected.length; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (e === undefined || a === undefined) {
      continue;
    }
    const found = semanticMismatch(e, a, policy, `${basePath}[${i}]`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** Compare two `dict` entry lists: keys byte-exact, values recursive. */
function dictMismatch(
  expected: readonly DictEntry[],
  actual: readonly DictEntry[],
  policy: ComparisonPolicy,
  path: string,
  expectedNode: CanonicalValue,
  actualNode: CanonicalValue,
): MaybeMismatch {
  if (expected.length !== actual.length) {
    return mismatch(path, "size differs", expectedNode, actualNode);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (e === undefined || a === undefined) {
      continue;
    }
    // Keys are structural: compared exactly, never relaxed by a tolerance.
    if (canonicalStringOf(e.key) !== canonicalStringOf(a.key)) {
      return mismatch(`${path}.entries[${i}].key`, "key differs", e.key, a.key);
    }
    const found = semanticMismatch(
      e.value,
      a.value,
      policy,
      `${path}.entries[${i}].value`,
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** Compare two `record` field lists: names exact, values recursive. */
function recordMismatch(
  expected: readonly RecordField[],
  actual: readonly RecordField[],
  policy: ComparisonPolicy,
  path: string,
  expectedNode: CanonicalValue,
  actualNode: CanonicalValue,
): MaybeMismatch {
  if (expected.length !== actual.length) {
    return mismatch(path, "field count differs", expectedNode, actualNode);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (e === undefined || a === undefined) {
      continue;
    }
    if (e.name !== a.name) {
      return mismatch(
        `${path}.fields[${i}].name`,
        "field name differs",
        expectedNode,
        actualNode,
      );
    }
    const found = semanticMismatch(
      e.value,
      a.value,
      policy,
      `${path}.fields[${i}].value`,
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** Compare two level-order `TreeNode` slot arrays (each slot may be `null`). */
function treeNodeMismatch(
  expected: readonly (CanonicalValue | null)[],
  actual: readonly (CanonicalValue | null)[],
  policy: ComparisonPolicy,
  path: string,
  expectedNode: CanonicalValue,
  actualNode: CanonicalValue,
): MaybeMismatch {
  if (expected.length !== actual.length) {
    return mismatch(path, "length differs", expectedNode, actualNode);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const e = expected[i] ?? null;
    const a = actual[i] ?? null;
    if (e === null && a === null) {
      continue;
    }
    if (e === null || a === null) {
      return mismatch(
        `${path}.values[${i}]`,
        "slot presence differs",
        expectedNode,
        actualNode,
      );
    }
    const found = semanticMismatch(e, a, policy, `${path}.values[${i}]`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** Compare two `ClassTrace` values: constructor then operations, in order. */
function classTraceMismatch(
  expected: Extract<CanonicalValue, { tag: "ClassTrace" }>,
  actual: Extract<CanonicalValue, { tag: "ClassTrace" }>,
  policy: ComparisonPolicy,
  path: string,
): MaybeMismatch {
  if (expected.className !== actual.className) {
    return mismatch(path, "className differs", expected, actual);
  }
  if (expected.constructor.length !== actual.constructor.length) {
    return mismatch(`${path}.constructor`, "length differs", expected, actual);
  }
  const ctor = itemsMismatch(
    expected.constructor,
    actual.constructor,
    policy,
    `${path}.constructor`,
  );
  if (ctor !== null) {
    return ctor;
  }
  if (expected.operations.length !== actual.operations.length) {
    return mismatch(`${path}.operations`, "length differs", expected, actual);
  }
  for (let i = 0; i < expected.operations.length; i += 1) {
    const e = expected.operations[i];
    const a = actual.operations[i];
    if (e === undefined || a === undefined) {
      continue;
    }
    const opPath = `${path}.operations[${i}]`;
    if (e.method !== a.method) {
      return mismatch(`${opPath}.method`, "method differs", expected, actual);
    }
    if (e.args.length !== a.args.length) {
      return mismatch(`${opPath}.args`, "length differs", expected, actual);
    }
    const args = itemsMismatch(e.args, a.args, policy, `${opPath}.args`);
    if (args !== null) {
      return args;
    }
    const eHas = e.expected !== undefined;
    const aHas = a.expected !== undefined;
    if (eHas !== aHas) {
      return mismatch(
        `${opPath}.expected`,
        "expected presence differs",
        expected,
        actual,
      );
    }
    if (e.expected !== undefined && a.expected !== undefined) {
      const found = semanticMismatch(
        e.expected,
        a.expected,
        policy,
        `${opPath}.expected`,
      );
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Whether two finite numbers are equal within a numeric tolerance.
 *
 * They pass iff the absolute difference is within `absolute`, or within
 * `relative` scaled by the larger magnitude. Non-finite inputs never pass.
 *
 * @param a - Expected magnitude.
 * @param b - Actual magnitude.
 * @param tol - The absolute/relative bounds.
 * @returns `true` iff `a` and `b` are within tolerance.
 */
export function withinTolerance(
  a: number,
  b: number,
  tol: NumericTolerance,
): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }
  const diff = Math.abs(a - b);
  if (diff <= tol.absolute) {
    return true;
  }
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= tol.relative * scale;
}

/**
 * Collapse leading/trailing whitespace and internal whitespace runs to a single
 * space. Applied only to `str` leaves when the policy opts in.
 */
function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Build a bounded {@link ComparisonMismatch} at `path`. */
function mismatch(
  path: string,
  reason: string,
  expected: CanonicalValue,
  actual: CanonicalValue,
): ComparisonMismatch {
  return {
    path,
    reason,
    expected: renderValue(expected),
    actual: renderValue(actual),
  };
}
