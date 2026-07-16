/**
 * Deterministic ordering policy for paired benchmark repetitions.
 *
 * The policy operates entirely on unsigned 64-bit integers.  It deliberately
 * does not use `Math.random()`: the persisted decimal seed, case ordinal, and
 * sample ordinal fully determine an order on every supported platform.
 */

/** Largest value representable by an unsigned 64-bit integer. */
export const UINT64_MAX = (1n << 64n) - 1n;

const UINT64_MODULUS = UINT64_MAX + 1n;
const SPLITMIX_INCREMENT = 0x9e3779b97f4a7c15n;
const MIX_A = 0xbf58476d1ce4e5b9n;
const MIX_B = 0x94d049bb133111ebn;

/** A canonical, persisted unsigned-64-bit seed represented as decimal text. */
export type Uint64Seed = bigint;

/**
 * Parse canonical decimal uint64 text.
 *
 * Leading zeroes are rejected (except for `"0"`) so equal seeds always have
 * exactly one persisted representation.
 */
export function parseUint64Seed(value: string): Uint64Seed {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new RangeError(
      "A uint64 seed must be canonical unsigned decimal text.",
    );
  }
  const seed = BigInt(value);
  return assertUint64(seed, "seed");
}

/** Return the canonical decimal representation required for persisted seeds. */
export function formatUint64Seed(seed: Uint64Seed): string {
  return assertUint64(seed, "seed").toString();
}

/**
 * Produce the paired execution order for one case/repetition.
 *
 * `ordinal` is the benchmark sample ordinal, including warmups.  Consequently,
 * callers can use the same function across the warmup/measurement boundary
 * without resetting either the ordering stream or persisted ordinals.
 *
 * Fisher--Yates is performed over a copy: the supplied implementation list is
 * never changed.  Rejection sampling removes modulo bias when converting a
 * uint64 PRNG output to a swap index.
 */
export function pairedFisherYatesOrder<T>(
  implementations: readonly T[],
  orderSeed: Uint64Seed,
  caseOrdinal: number,
  ordinal: number,
): readonly T[] {
  const state = createState(orderSeed, caseOrdinal, ordinal);
  const ordered = [...implementations];
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swapIndex = nextIndex(state, index + 1);
    const current = ordered[index];
    ordered[index] = ordered[swapIndex]!;
    ordered[swapIndex] = current!;
  }
  return Object.freeze(ordered);
}

/** Alias with an order-first name for call sites that build a benchmark plan. */
export const orderImplementations = pairedFisherYatesOrder;

interface GeneratorState {
  value: bigint;
}

function createState(
  seed: Uint64Seed,
  caseOrdinal: number,
  ordinal: number,
): GeneratorState {
  assertUint64(seed, "seed");
  assertOrdinal(caseOrdinal, "caseOrdinal");
  assertOrdinal(ordinal, "ordinal");

  // Independently mix both coordinates before combining them.  This is a
  // domain-separated stream per (caseOrdinal, ordinal), rather than a single
  // stream whose prior consumption could affect a later repetition.
  const casePart = mix64(BigInt(caseOrdinal) + 0x243f6a8885a308d3n);
  const ordinalPart = rotateLeft(
    mix64(BigInt(ordinal) + 0x13198a2e03707344n),
    32n,
  );
  return { value: mix64(seed ^ casePart ^ ordinalPart) };
}

function nextIndex(state: GeneratorState, exclusiveUpperBound: number): number {
  const bound = BigInt(exclusiveUpperBound);
  const acceptedBelow = UINT64_MODULUS - (UINT64_MODULUS % bound);
  let candidate = nextUint64(state);
  while (candidate >= acceptedBelow) candidate = nextUint64(state);
  return Number(candidate % bound);
}

function nextUint64(state: GeneratorState): bigint {
  state.value = (state.value + SPLITMIX_INCREMENT) & UINT64_MAX;
  return mix64(state.value);
}

function mix64(value: bigint): bigint {
  let mixed = value & UINT64_MAX;
  mixed = ((mixed ^ (mixed >> 30n)) * MIX_A) & UINT64_MAX;
  mixed = ((mixed ^ (mixed >> 27n)) * MIX_B) & UINT64_MAX;
  return (mixed ^ (mixed >> 31n)) & UINT64_MAX;
}

function rotateLeft(value: bigint, places: bigint): bigint {
  return ((value << places) | (value >> (64n - places))) & UINT64_MAX;
}

function assertUint64(value: bigint, name: string): bigint {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError(`${name} must be an unsigned 64-bit integer.`);
  }
  return value;
}

function assertOrdinal(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}
