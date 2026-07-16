import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeFixedCaseDocument,
  FixedCaseError,
  streamFixedCases,
} from "../../../src/application/fixed-cases.js";
import type { Problem } from "../../../src/infrastructure/problem.js";

const PROBLEM: Problem = {
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
  args: [{ kind: "int" }],
  returns: { kind: "int" },
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function document(input = 1, expected = 2): string {
  return JSON.stringify({ input: [input], expected });
}

async function fixture(): Promise<{ root: string; cases: string }> {
  const root = await mkdtemp(join(tmpdir(), "palestra-fixed-cases-"));
  roots.push(root);
  const cases = join(root, "cases");
  await mkdir(cases);
  return { root, cases };
}

describe("fixed case source", () => {
  it("losslessly constructs canonical tagged values from a legacy document", () => {
    const decoded = decodeFixedCaseDocument(
      new TextEncoder().encode(document("9007199254740992", 2)),
      PROBLEM,
    );
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.input).toEqual({
      tag: "tuple",
      items: [{ tag: "int", value: 9007199254740992n }],
    });
    expect(decoded.grouped).toBe(false);
  });

  it("requires strict legacy and grouped wrapper/member shapes", () => {
    expect(() =>
      decodeFixedCaseDocument(
        new TextEncoder().encode('{"input":[null]}'),
        PROBLEM,
      ),
    ).toThrow(FixedCaseError);
    expect(() =>
      decodeFixedCaseDocument(
        new TextEncoder().encode(
          '{"input":[null],"expected":null,"extra":null}',
        ),
        PROBLEM,
      ),
    ).toThrow("exactly the keys");
    expect(() =>
      decodeFixedCaseDocument(
        new TextEncoder().encode('{"cases":[]}'),
        PROBLEM,
      ),
    ).toThrow("must not be empty");
    expect(() =>
      decodeFixedCaseDocument(
        new TextEncoder().encode('{"cases":{"input":[1],"expected":1}}'),
        PROBLEM,
      ),
    ).toThrow('"cases" must be an array');
    expect(() =>
      decodeFixedCaseDocument(
        new TextEncoder().encode('{"cases":[{"input":[1]}]}'),
        PROBLEM,
      ),
    ).toThrow("case #0 must contain exactly");
    expect(() =>
      decodeFixedCaseDocument(
        new TextEncoder().encode('{"cases":[],"extra":true}'),
        PROBLEM,
      ),
    ).toThrow("grouped wrapper");
    expect(() =>
      decodeFixedCaseDocument(
        new TextEncoder().encode(
          '{"cases":[{"input":[1],"input":[2],"expected":1}]}',
        ),
        PROBLEM,
      ),
    ).toThrow("invalid JSON");
  });

  it("streams files lexically and grouped members in array order", async () => {
    const { root, cases } = await fixture();
    await writeFile(join(cases, "z.json"), document());
    await writeFile(
      join(cases, "a.json"),
      JSON.stringify({
        cases: [
          { input: [1], expected: 1 },
          { input: [2], expected: 2 },
        ],
      }),
    );
    const actual: string[] = [];
    for await (const value of streamFixedCases({
      problemRoot: root,
      casesDir: cases,
      invocationDirectory: root,
      problem: PROBLEM,
    })) {
      actual.push(value.relativePath);
    }
    expect(actual).toEqual([
      "cases/a.json#0",
      "cases/a.json#1",
      "cases/z.json#0",
    ]);
  });

  it("uses an existing invocation-relative override before cases-dir fallback", async () => {
    const { root, cases } = await fixture();
    await writeFile(join(root, "chosen.json"), document(3, 4));
    await writeFile(join(cases, "chosen.json"), document(1, 2));
    const values = [];
    for await (const value of streamFixedCases({
      problemRoot: root,
      casesDir: cases,
      invocationDirectory: root,
      problem: PROBLEM,
      caseOverride: "chosen.json",
    }))
      values.push(value);
    expect(values).toHaveLength(1);
    expect(values[0]?.relativePath).toBe("chosen.json#0");
    expect(values[0]?.input).toEqual({
      tag: "tuple",
      items: [{ tag: "int", value: 3n }],
    });
  });

  it("selects every member of a grouped --case file", async () => {
    const { root, cases } = await fixture();
    await writeFile(
      join(cases, "group.json"),
      JSON.stringify({
        cases: [
          { input: [3], expected: 3 },
          { input: [4], expected: 4 },
        ],
      }),
    );
    const values = [];
    for await (const value of streamFixedCases({
      problemRoot: root,
      casesDir: cases,
      invocationDirectory: root,
      problem: PROBLEM,
      caseOverride: "group.json",
    }))
      values.push(value.relativePath);
    expect(values).toEqual(["cases/group.json#0", "cases/group.json#1"]);
  });

  it("rejects oversized grouped documents before decoding members", async () => {
    const { root, cases } = await fixture();
    await writeFile(
      join(cases, "large.json"),
      JSON.stringify({ cases: [{ input: [1], expected: 1 }] }),
    );
    await expect(async () => {
      for await (const _value of streamFixedCases({
        problemRoot: root,
        casesDir: cases,
        invocationDirectory: root,
        problem: PROBLEM,
        maxBytes: 8,
      })) {
        /* consume */
      }
    }).rejects.toThrow("exceeds 8 bytes");
  });

  it("rejects a selected case that escapes the problem root", async () => {
    const { root, cases } = await fixture();
    const outside = `${root}-outside.json`;
    roots.push(outside);
    await writeFile(outside, document());
    await expect(async () => {
      for await (const _value of streamFixedCases({
        problemRoot: root,
        casesDir: cases,
        invocationDirectory: root,
        problem: PROBLEM,
        caseOverride: `../${root.split("/").pop()}-outside.json`,
      })) {
        /* consume */
      }
    }).rejects.toThrow("escapes the problem root");
  });

  it("rejects non-json and symlink entries rather than executing them", async () => {
    const { root, cases } = await fixture();
    await writeFile(join(cases, "not-json.txt"), "x");
    await expect(async () => {
      for await (const _value of streamFixedCases({
        problemRoot: root,
        casesDir: cases,
        invocationDirectory: root,
        problem: PROBLEM,
      })) {
        /* consume */
      }
    }).rejects.toThrow("non-.json");

    await writeFile(join(cases, "a.json"), document());
    await symlink(join(cases, "a.json"), join(cases, "link.json"));
    await expect(async () => {
      for await (const _value of streamFixedCases({
        problemRoot: root,
        casesDir: cases,
        invocationDirectory: root,
        problem: PROBLEM,
      })) {
        /* consume */
      }
    }).rejects.toThrow(FixedCaseError);
  });
});
