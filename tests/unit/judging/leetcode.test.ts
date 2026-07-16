import { describe, expect, it } from "vitest";
import { parseJson } from "../../../src/judging/codec/json.js";
import {
  decodeLeetCodeCase,
  LeetCodeValueError,
} from "../../../src/judging/leetcode.js";
import type { Problem } from "../../../src/infrastructure/problem.js";

function json(text: string) {
  const result = parseJson(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.node;
}
const functionProblem: Problem = {
  schemaVersion: 1,
  slug: "sample",
  title: "Sample",
  entrypoint: "solution.py",
  casesDir: "cases",
  limits: {},
  runtime: "python-uv",
  inputCodec: "tagged-jsonl-v1",
  outputCodec: "tagged-jsonl-v1",
  comparisonPolicy: "exact-v1",
  kind: "function",
  args: [
    { kind: "int" },
    { kind: "str" },
    { kind: "TreeNode", item: { kind: "int" } },
  ],
  returns: { kind: "ListNode", item: { kind: "int" } },
};
const classProblem: Problem = {
  schemaVersion: 1,
  slug: "cache",
  title: "Cache",
  entrypoint: "solution.py",
  casesDir: "cases",
  limits: {},
  runtime: "python-uv",
  inputCodec: "tagged-jsonl-v1",
  outputCodec: "tagged-jsonl-v1",
  comparisonPolicy: "exact-v1",
  kind: "class",
  className: "Cache",
  constructor: [{ kind: "int" }],
  methods: {
    put: { args: [{ kind: "int" }], returns: { kind: "null" } },
    get: { args: [], returns: { kind: "int" } },
  },
};

describe("plain LeetCode case decoding", () => {
  it("consults signatures before JSON representation and adapts nodes", () => {
    const decoded = decodeLeetCodeCase(
      json('["9007199254740992", "123", [1, null, 2, 3]]'),
      json("[4, 5]"),
      functionProblem,
    );
    expect(decoded.input).toEqual({
      tag: "tuple",
      items: [
        { tag: "int", value: 9007199254740992n },
        { tag: "str", value: "123" },
        {
          tag: "TreeNode",
          values: [
            { tag: "int", value: 1n },
            null,
            { tag: "int", value: 2n },
            { tag: "int", value: 3n },
          ],
        },
      ],
    });
    expect(decoded.expected).toEqual({
      tag: "ListNode",
      values: [
        { tag: "int", value: 4n },
        { tag: "int", value: 5n },
      ],
      cycleIndex: null,
    });
  });

  it("enforces index-aligned LeetCode class traces and constructor null", () => {
    const decoded = decodeLeetCodeCase(
      json('[["Cache", "put", "get"], [[2], [1], []]]'),
      json("[null, null, 1]"),
      classProblem,
    );
    expect(decoded.input).toMatchObject({
      tag: "ClassTrace",
      className: "Cache",
      constructor: [{ tag: "int", value: 2n }],
    });
    expect(decoded.expected).toEqual({
      tag: "list",
      items: [{ tag: "null" }, { tag: "null" }, { tag: "int", value: 1n }],
    });
    expect(() =>
      decodeLeetCodeCase(json('[["Cache"], [[2]]]'), json("[1]"), classProblem),
    ).toThrow("expected[0] must be null");
    expect(() =>
      decodeLeetCodeCase(
        json('[["Cache", "missing"], [[2], []]]'),
        json("[null, null]"),
        classProblem,
      ),
    ).toThrow(LeetCodeValueError);
  });
});
