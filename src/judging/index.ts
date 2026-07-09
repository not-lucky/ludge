/**
 * Public surface of the judging layer.
 *
 * Re-exports the canonical value model, the judging ports, and the
 * `tagged-jsonl-v1` codec (factory, version helpers, envelope API, limits, and
 * error types). Downstream layers depend on this barrel rather than reaching
 * into individual codec modules.
 */

// Canonical value model (types only).
export type * from "./value/index.js";

// Judging ports (types only).
export type * from "./ports/index.js";

// The tagged-jsonl-v1 codec.
export * from "./codec/index.js";
