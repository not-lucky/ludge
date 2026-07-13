/**
 * Shared CLI value types with no behavior dependencies.
 *
 * Keeping the command identity and JSON value vocabulary here prevents the
 * parser/outcome modules from importing one another merely for types, preserving
 * the acyclic composition-root dependency graph.
 */

/** Every command accepted by the schema-v1 CLI. */
export const COMMAND_NAMES = [
  "init",
  "test",
  "stress-test",
  "watch",
  "benchmark",
  "report",
  "replay",
] as const;

/** Stable command names used in parsed commands and JSON envelopes. */
export type CommandName = (typeof COMMAND_NAMES)[number];

/** A JSON-safe value accepted in command results and diagnostic details. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
