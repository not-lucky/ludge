/**
 * Unit tests for the `problem.yaml` schema v1 loader.
 *
 * These assert that documented defaults are applied for omitted optional
 * fields, that a fully specified document round-trips into a frozen config, and
 * that every rejection path — unknown field, wrong type, missing required
 * field, malformed slug, unsupported schema version, and out-of-range or
 * non-integer limits — fails closed with a {@link ProblemConfigError}.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_CASES_DIR,
  DEFAULT_COMPARISON_POLICY,
  DEFAULT_INPUT_CODEC,
  DEFAULT_RUNTIME,
  loadProblemConfig,
  ProblemConfigError,
} from "../../../src/infrastructure/config/index.js";

/** A minimal valid document with only the required fields present. */
const MINIMAL = [
  "schemaVersion: 1",
  "slug: two-sum",
  "title: Two Sum",
  "entrypoint: solution.py",
  "limits: {}",
].join("\n");

describe("loadProblemConfig", () => {
  it("applies documented defaults for omitted optional fields", () => {
    const config = loadProblemConfig(MINIMAL);
    expect(config.runtime).toBe(DEFAULT_RUNTIME);
    expect(config.inputCodec).toBe(DEFAULT_INPUT_CODEC);
    expect(config.comparisonPolicy).toBe(DEFAULT_COMPARISON_POLICY);
    expect(config.casesDir).toBe(DEFAULT_CASES_DIR);
    expect(config.limits).toEqual({});
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("parses a fully specified document including partial limits", () => {
    const text = [
      "schemaVersion: 1",
      "slug: strict-example",
      'title: "Strict Example"',
      "entrypoint: solution.py",
      "runtime: python-uv",
      "inputCodec: tagged-jsonl-v1",
      "outputCodec: tagged-jsonl-v1",
      "comparisonPolicy: exact-v1",
      "casesDir: cases",
      "generator: generator.py",
      "naive: naive.py",
      "classProtocol: null",
      "limits:",
      "  memoryBytes: 33554432",
      "  wallTimeMs: 500",
    ].join("\n");
    const config = loadProblemConfig(text);
    expect(config.slug).toBe("strict-example");
    expect(config.title).toBe("Strict Example");
    expect(config.generator).toBe("generator.py");
    expect(config.naive).toBe("naive.py");
    expect(config.classProtocol).toBeNull();
    expect(config.limits).toEqual({ memoryBytes: 33_554_432, wallTimeMs: 500 });
  });

  it("rejects an unknown top-level field", () => {
    expect(() => loadProblemConfig(`${MINIMAL}\nmystery: 1`)).toThrow(
      ProblemConfigError,
    );
  });

  it("rejects a wrong-typed field", () => {
    const text = [
      "schemaVersion: 1",
      "slug: two-sum",
      "title: 12345",
      "entrypoint: solution.py",
      "limits: {}",
    ].join("\n");
    expect(() => loadProblemConfig(text)).toThrow(/title/u);
  });

  it("rejects a missing required field", () => {
    const text = ["schemaVersion: 1", "slug: two-sum", "limits: {}"].join("\n");
    expect(() => loadProblemConfig(text)).toThrow(/entrypoint|title/u);
  });

  it("rejects a malformed slug", () => {
    const text = MINIMAL.replace("slug: two-sum", "slug: Two_Sum");
    expect(() => loadProblemConfig(text)).toThrow(/slug/u);
  });

  it("rejects an unsupported schema version", () => {
    const text = MINIMAL.replace("schemaVersion: 1", "schemaVersion: 2");
    expect(() => loadProblemConfig(text)).toThrow(/schemaVersion/u);
  });

  it("rejects an unknown limit key", () => {
    const text = `${MINIMAL.replace("limits: {}", "limits:")}\n  bogus: 1`;
    expect(() => loadProblemConfig(text)).toThrow(/unknown limit/u);
  });

  it("rejects a zero or negative limit", () => {
    const zero = `${MINIMAL.replace("limits: {}", "limits:")}\n  memoryBytes: 0`;
    expect(() => loadProblemConfig(zero)).toThrow(/positive/u);
    const negative = `${MINIMAL.replace("limits: {}", "limits:")}\n  memoryBytes: -1`;
    expect(() => loadProblemConfig(negative)).toThrow(/positive/u);
  });

  it("rejects a limit integer outside the safe range", () => {
    const huge = `${MINIMAL.replace("limits: {}", "limits:")}\n  memoryBytes: 99999999999999999999`;
    expect(() => loadProblemConfig(huge)).toThrow(/safe range/u);
  });

  it("reports the offending field on the error", () => {
    const text = `${MINIMAL.replace("limits: {}", "limits:")}\n  memoryBytes: 0`;
    try {
      loadProblemConfig(text);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemConfigError);
      expect((err as ProblemConfigError).field).toBe("limits.memoryBytes");
      expect((err as ProblemConfigError).exitCode).toBe(3);
    }
  });
});
