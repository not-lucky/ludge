/**
 * Unit tests for safe path resolution.
 *
 * These assert the CLI contract's path rules: NUL bytes are rejected, a
 * problem-local path is confined to the problem root (escapes are rejected),
 * CLI paths resolve against the invocation directory, and a CLI override wins
 * over a problem-local default.
 */

import { describe, it, expect } from "vitest";
import {
  PathResolutionError,
  resolveInvocationPath,
  resolveOverridablePath,
  resolveProblemLocalPath,
} from "../../../src/infrastructure/config/index.js";
import type { PathContext } from "../../../src/infrastructure/config/index.js";

const CTX: PathContext = {
  invocationDir: "/work/invoke",
  problemRoot: "/work/problems/two-sum",
};

describe("resolveProblemLocalPath", () => {
  it("resolves a relative path under the problem root", () => {
    expect(resolveProblemLocalPath(CTX, "solution.py")).toBe(
      "/work/problems/two-sum/solution.py",
    );
  });

  it("normalizes interior traversal that stays inside the root", () => {
    expect(resolveProblemLocalPath(CTX, "sub/../solution.py")).toBe(
      "/work/problems/two-sum/solution.py",
    );
  });

  it("rejects a path that escapes the problem root", () => {
    expect(() => resolveProblemLocalPath(CTX, "../secrets")).toThrow(
      PathResolutionError,
    );
    expect(() => resolveProblemLocalPath(CTX, "/etc/passwd")).toThrow(
      PathResolutionError,
    );
  });

  it("rejects a NUL byte", () => {
    expect(() => resolveProblemLocalPath(CTX, "sol\0.py")).toThrow(
      PathResolutionError,
    );
  });
});

describe("resolveInvocationPath", () => {
  it("resolves a relative path against the invocation directory", () => {
    expect(resolveInvocationPath(CTX, "cases/1.txt")).toBe(
      "/work/invoke/cases/1.txt",
    );
  });

  it("keeps an absolute path", () => {
    expect(resolveInvocationPath(CTX, "/somewhere/else.py")).toBe(
      "/somewhere/else.py",
    );
  });

  it("rejects a NUL byte", () => {
    expect(() => resolveInvocationPath(CTX, "a\0b")).toThrow(
      PathResolutionError,
    );
  });
});

describe("resolveOverridablePath", () => {
  it("uses the problem-local default when no override is given", () => {
    expect(
      resolveOverridablePath(CTX, { problemLocalDefault: "solution.py" }),
    ).toBe("/work/problems/two-sum/solution.py");
  });

  it("lets a CLI override win, resolved against the invocation dir", () => {
    expect(
      resolveOverridablePath(CTX, {
        cliOverride: "mine.py",
        problemLocalDefault: "solution.py",
      }),
    ).toBe("/work/invoke/mine.py");
  });

  it("allows a CLI override to point outside the problem root", () => {
    expect(
      resolveOverridablePath(CTX, {
        cliOverride: "/tmp/experiment.py",
        problemLocalDefault: "solution.py",
      }),
    ).toBe("/tmp/experiment.py");
  });
});
