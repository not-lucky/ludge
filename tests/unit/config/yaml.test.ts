/**
 * Unit tests for the hand-rolled YAML subset parser.
 *
 * These assert that the parser accepts exactly the constructs `problem.yaml`
 * uses — scalars, quoted strings, nested block mappings, empty flow
 * collections, comments, and blank lines — and rejects everything outside that
 * subset (duplicate keys, tab indentation, non-empty flow, inconsistent indent)
 * as a structured error rather than silently.
 */

import { describe, it, expect } from "vitest";
import {
  parseYaml,
  type YamlNode,
} from "../../../src/infrastructure/problem.js";

/** Assert a parse succeeded and return the root map's entries. */
function entriesOf(text: string): ReadonlyMap<string, YamlNode> {
  const result = parseYaml(text);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  expect(result.node.kind).toBe("map");
  if (result.node.kind !== "map") {
    throw new Error("unreachable");
  }
  return result.node.entries;
}

describe("parseYaml", () => {
  it("parses scalars, quoted strings, null, bool, and empty flow collections", () => {
    const text = [
      "# a leading comment",
      "schemaVersion: 1",
      "slug: two-sum",
      'title: "Two Sum"',
      "single: 'it''s fine'",
      "enabled: true",
      "disabled: false",
      "classProtocol: null",
      "tilde: ~",
      "limits: {}",
      "items: []",
      "",
    ].join("\n");

    const entries = entriesOf(text);
    expect(entries.get("schemaVersion")).toEqual({ kind: "int", raw: "1" });
    expect(entries.get("slug")).toEqual({ kind: "string", value: "two-sum" });
    expect(entries.get("title")).toEqual({ kind: "string", value: "Two Sum" });
    expect(entries.get("single")).toEqual({
      kind: "string",
      value: "it's fine",
    });
    expect(entries.get("enabled")).toEqual({ kind: "bool", value: true });
    expect(entries.get("disabled")).toEqual({ kind: "bool", value: false });
    expect(entries.get("classProtocol")).toEqual({ kind: "null" });
    expect(entries.get("tilde")).toEqual({ kind: "null" });
    expect(entries.get("limits")).toEqual({ kind: "map", entries: new Map() });
    expect(entries.get("items")).toEqual({ kind: "list", items: [] });
  });

  it("parses a nested block mapping", () => {
    const text = [
      "limits:",
      "  memoryBytes: 1024",
      "  wallTimeMs: 2000",
      "after: x",
    ].join("\n");
    const entries = entriesOf(text);
    const limits = entries.get("limits");
    expect(limits?.kind).toBe("map");
    if (limits?.kind !== "map") {
      throw new Error("unreachable");
    }
    expect(limits.entries.get("memoryBytes")).toEqual({
      kind: "int",
      raw: "1024",
    });
    expect(limits.entries.get("wallTimeMs")).toEqual({
      kind: "int",
      raw: "2000",
    });
    expect(entries.get("after")).toEqual({ kind: "string", value: "x" });
  });

  it("preserves a '#' inside a quoted scalar as literal text", () => {
    const entries = entriesOf('title: "a # b"');
    expect(entries.get("title")).toEqual({ kind: "string", value: "a # b" });
  });

  it("treats an empty document as an empty mapping", () => {
    const entries = entriesOf("# only a comment\n\n");
    expect(entries.size).toBe(0);
  });

  it("rejects a duplicate key", () => {
    const result = parseYaml("a: 1\na: 2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.error.message).toMatch(/duplicate key/u);
    expect(result.error.line).toBe(2);
  });

  it("rejects tab indentation", () => {
    const result = parseYaml("limits:\n\tmemoryBytes: 1");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.error.message).toMatch(/tab/u);
  });

  it("rejects a non-empty flow collection", () => {
    const result = parseYaml("limits: {a: 1}");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.error.message).toMatch(/unsupported/u);
  });

  it("rejects unexpected indentation", () => {
    const result = parseYaml("a: 1\n  b: 2");
    expect(result.ok).toBe(false);
  });

  it("rejects a line without a mapping colon", () => {
    const result = parseYaml("not a mapping");
    expect(result.ok).toBe(false);
  });

  it("rejects a document that does not start at the left margin", () => {
    const result = parseYaml("  a: 1");
    expect(result.ok).toBe(false);
  });
});
