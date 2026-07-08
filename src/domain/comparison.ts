/**
 * Comparison policy and result value contracts.
 *
 * A {@link ComparisonPolicy} is a versioned, immutable description of how two
 * decoded canonical values are judged equal; a {@link ComparisonResult} is the
 * verdict a comparator returns. The domain defines the shapes only — concrete
 * comparators live in the judging layer (task 05).
 *
 * This module is pure: no runtime, adapter, or Node import.
 */

/**
 * Per-problem numeric tolerance applied only to finite numeric leaves.
 *
 * It never affects string, integer, container-shape, or exception semantics.
 */
export interface NumericTolerance {
  /** Maximum permitted absolute difference; a finite, non-negative number. */
  readonly absolute: number;
  /** Maximum permitted relative difference; a finite, non-negative number. */
  readonly relative: number;
}

/** How two values are judged equal. */
export type EqualityMode =
  /** Structural/semantic equality of decoded canonical values (default). */
  | "semantic"
  /** Exact equality of canonical encoded bytes. */
  | "canonical_bytes";

/**
 * A versioned, immutable comparison policy.
 *
 * The `version` identifier (for example `"exact-v1"`) selects a concrete
 * comparator; readers reject unsupported major versions.
 */
export interface ComparisonPolicy {
  /** Stable version identifier of the policy. */
  readonly version: string;
  /** Which equality notion applies. */
  readonly equality: EqualityMode;
  /** Whether whitespace may be normalized; permitted only for text outputs. */
  readonly normalizeWhitespace: boolean;
  /** Optional numeric tolerance for finite numeric leaves. */
  readonly tolerance?: NumericTolerance;
}

/**
 * Bounded description of the first location where two values differ.
 *
 * Field values are already-bounded, human-oriented renderings for reporting;
 * they are diagnostics, never re-parsed as canonical data.
 */
export interface ComparisonMismatch {
  /** Canonical path to the differing leaf (e.g. `"$.items[3].value"`). */
  readonly path: string;
  /** Short reason the leaves were judged unequal. */
  readonly reason: string;
  /** Bounded rendering of the expected leaf. */
  readonly expected: string;
  /** Bounded rendering of the actual leaf. */
  readonly actual: string;
}

/**
 * The verdict of comparing an expected value against an actual value under a
 * {@link ComparisonPolicy}.
 *
 * When `equal` is `true`, `mismatch` is absent. When `equal` is `false`,
 * `mismatch` describes the first difference found.
 */
export type ComparisonResult =
  | { readonly equal: true }
  | { readonly equal: false; readonly mismatch: ComparisonMismatch };
