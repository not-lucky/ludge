import { describe, expect, it } from "vitest";
import {
  normalizeProblemPath,
  redactInput,
  redactTelemetryData,
} from "../../../src/telemetry/index.js";

describe("telemetry redaction", () => {
  it("redacts secrets and source while retaining only allowed environment values", () => {
    const data = redactTelemetryData(
      {
        apiToken: "do-not-log",
        sourceCode: "def solve(): return secret",
        environment: { PATH: "/usr/bin", HOME: "/home/alice", LANG: "C.UTF-8" },
      },
      { problemRoot: "/work/problem" },
    );

    expect(data).toEqual({
      apiToken: "[redacted]",
      sourceCode: "[redacted]",
      environment: { PATH: "/usr/bin", HOME: "[redacted]", LANG: "C.UTF-8" },
    });
  });

  it("hashes input unless verbose input is explicitly enabled", () => {
    expect(redactInput("hello")).toEqual({
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      bytes: 5,
    });
    expect(redactInput("hello", true)).toBe("hello");
  });

  it("normalizes only paths contained by the problem root", () => {
    expect(
      normalizeProblemPath("/work/problem/solutions/main.py", "/work/problem"),
    ).toBe("solutions/main.py");
    expect(normalizeProblemPath("/etc/passwd", "/work/problem")).toBe(
      "[redacted path]",
    );
  });
});
