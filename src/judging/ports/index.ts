/**
 * Public surface of the judging ports.
 *
 * These are the runtime-neutral judging contracts — the value {@link Codec} and
 * the {@link OutputComparator} Strategy — that the application/judging policy
 * layers depend on. Concrete implementations arrive in tasks 04 (codec) and 05
 * (comparators). This barrel is type-only and imports no adapter.
 */

// Value codec and its result types.
export type { Codec, DecodeError, DecodeResult } from "./codec.js";

// Output comparator strategy.
export type { OutputComparator } from "./comparator.js";
