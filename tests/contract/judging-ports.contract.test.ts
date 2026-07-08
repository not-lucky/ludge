/**
 * Contract-test scaffold for the judging ports.
 *
 * These suites enumerate the obligations any concrete {@link Codec} and
 * {@link OutputComparator} must satisfy. They are `todo` placeholders: task 04
 * (canonical codec) and task 05 (comparators) supply fixtures that drive these
 * obligations against real implementations.
 */

import { describe, it } from "vitest";
import type {
  Codec,
  DecodeResult,
  OutputComparator,
} from "../../src/judging/ports/index.js";

// Retain the type-only imports and verify the port surface exists.
type _PortSurface = [
  Codec<unknown>,
  DecodeResult<unknown>,
  OutputComparator<unknown>,
];

describe("Codec contract", () => {
  it.todo("encode() then decode() round-trips a canonical value exactly");
  it.todo("decode() returns { ok: false } (never throws) on malformed bytes");
  it.todo("decode() rejects inputs that exceed depth/node/size limits");
  it.todo("decode() rejects unknown tags, duplicate keys, and invalid UTF-8");
});

describe("OutputComparator contract", () => {
  it.todo("compare() reports equality for structurally equal values");
  it.todo("compare() returns the first mismatch path for unequal values");
  it.todo("compare() honors numeric tolerance only on finite numeric leaves");
  it.todo("compare() applies whitespace normalization only for text outputs");
});
