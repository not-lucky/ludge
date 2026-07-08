/**
 * Identity and generation value types for the domain layer.
 *
 * These are nominal ("branded") aliases over primitive types. Branding gives
 * compile-time protection against mixing, for example, a {@link RunId} with a
 * {@link CaseId} or a raw string, without any runtime cost — the brand is a
 * phantom field that exists only in the type system.
 *
 * This module is pure: it imports nothing and holds no mutable state.
 */

declare const brand: unique symbol;

/**
 * Attach a phantom brand `B` to base type `T`. The value is structurally still
 * a `T` at runtime; the brand exists only to make the alias nominal.
 */
type Branded<T, B extends string> = T & { readonly [brand]: B };

/** Opaque identifier for a single run (one execution of a solution/case). */
export type RunId = Branded<string, "RunId">;

/** Opaque identifier for a single test case within a problem. */
export type CaseId = Branded<string, "CaseId">;

/**
 * A monotonically increasing watch-generation counter.
 *
 * Each rescan of a watched problem advances the generation. Results are tagged
 * with the generation that produced them so that a late result from an older
 * generation can be detected and discarded rather than committed over a newer
 * run. See {@link isNewerGeneration}.
 */
export type Generation = Branded<number, "Generation">;

/**
 * Wrap a non-empty string as a {@link RunId}.
 *
 * @param value - The underlying identifier text.
 * @returns The value branded as a {@link RunId}.
 * @throws {RangeError} If `value` is empty.
 */
export function toRunId(value: string): RunId {
  if (value.length === 0) {
    throw new RangeError("RunId must be a non-empty string");
  }
  return value as RunId;
}

/**
 * Wrap a non-empty string as a {@link CaseId}.
 *
 * @param value - The underlying identifier text.
 * @returns The value branded as a {@link CaseId}.
 * @throws {RangeError} If `value` is empty.
 */
export function toCaseId(value: string): CaseId {
  if (value.length === 0) {
    throw new RangeError("CaseId must be a non-empty string");
  }
  return value as CaseId;
}

/** The generation assigned before any rescan has occurred. */
export function initialGeneration(): Generation {
  return 0 as Generation;
}

/**
 * Produce the generation that immediately follows `current`.
 *
 * @param current - The generation to advance from.
 * @returns `current + 1` as a {@link Generation}.
 */
export function nextGeneration(current: Generation): Generation {
  return (current + 1) as Generation;
}

/**
 * Report whether `candidate` belongs to a newer generation than `reference`.
 *
 * Used as a guard so that a result produced by `reference` cannot overwrite a
 * run already advanced to a newer `candidate` generation, and vice versa.
 *
 * @param candidate - The generation under consideration.
 * @param reference - The generation to compare against.
 * @returns `true` when `candidate` is strictly newer than `reference`.
 */
export function isNewerGeneration(
  candidate: Generation,
  reference: Generation,
): boolean {
  return candidate > reference;
}
