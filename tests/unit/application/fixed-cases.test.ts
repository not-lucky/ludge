import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeFixedCaseDocument,
  FixedCaseError,
  streamFixedCases,
} from "../../../src/application/fixed-cases.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  }));
});

function document(input = 1, expected = 2): string {
  return JSON.stringify({
    input: { tag: "int", value: input },
    expected: { tag: "int", value: expected },
  });
}

async function fixture(): Promise<{ root: string; cases: string }> {
  const root = await mkdtemp(join(tmpdir(), "palestra-fixed-cases-"));
  roots.push(root);
  const cases = join(root, "cases");
  await mkdir(cases);
  return { root, cases };
}

describe("fixed case source", () => {
  it("losslessly constructs canonical tagged values", () => {
    const decoded = decodeFixedCaseDocument(new TextEncoder().encode(document("9007199254740992", 2)));
    expect(decoded.input).toEqual({ tag: "int", value: 9007199254740992n });
  });

  it("requires exactly input and expected keys", () => {
    expect(() => decodeFixedCaseDocument(new TextEncoder().encode('{"input":{"tag":"null"}}')))
      .toThrow(FixedCaseError);
    expect(() => decodeFixedCaseDocument(new TextEncoder().encode('{"input":{"tag":"null"},"expected":{"tag":"null"},"extra":null}')))
      .toThrow("exactly the keys");
  });

  it("streams regular json files in lexical order", async () => {
    const { root, cases } = await fixture();
    await writeFile(join(cases, "z.json"), document());
    await writeFile(join(cases, "a.json"), document());
    const actual: string[] = [];
    for await (const value of streamFixedCases({ problemRoot: root, casesDir: cases, invocationDirectory: root })) {
      actual.push(value.relativePath);
    }
    expect(actual).toEqual(["cases/a.json", "cases/z.json"]);
  });

  it("uses an existing invocation-relative override before cases-dir fallback", async () => {
    const { root, cases } = await fixture();
    await writeFile(join(root, "chosen.json"), document(3, 4));
    await writeFile(join(cases, "chosen.json"), document(1, 2));
    const values = [];
    for await (const value of streamFixedCases({ problemRoot: root, casesDir: cases, invocationDirectory: root, caseOverride: "chosen.json" })) values.push(value);
    expect(values).toHaveLength(1);
    expect(values[0]?.input).toEqual({ tag: "int", value: 3n });
  });

  it("rejects non-json and symlink entries rather than executing them", async () => {
    const { root, cases } = await fixture();
    await writeFile(join(cases, "not-json.txt"), "x");
    await expect(async () => {
      for await (const _value of streamFixedCases({ problemRoot: root, casesDir: cases, invocationDirectory: root })) { /* consume */ }
    }).rejects.toThrow("non-.json");

    await writeFile(join(cases, "a.json"), document());
    await symlink(join(cases, "a.json"), join(cases, "link.json"));
    await expect(async () => {
      for await (const _value of streamFixedCases({ problemRoot: root, casesDir: cases, invocationDirectory: root })) { /* consume */ }
    }).rejects.toThrow(FixedCaseError);
  });
});
