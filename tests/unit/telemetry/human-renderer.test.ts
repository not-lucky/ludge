import { describe, expect, it } from "vitest";
import {
  MAX_HUMAN_FRAGMENT_LENGTH,
  renderHumanEvent,
} from "../../../src/telemetry/render/human.js";

type Event = Parameters<typeof renderHumanEvent>[0];

function event(overrides: {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly data: unknown;
}): Event {
  return {
    schemaVersion: 1,
    timestampUtc: "2026-01-01T00:00:00.000Z",
    monotonicNs: "0",
    runId: "run-1",
    caseId: null,
    component: "test",
    problemSlug: "example",
    implementationId: null,
    ...overrides,
  } as Event;
}

describe("human telemetry renderer", () => {
  it("renders info events to stdout using only the event fact and sorted data", () => {
    expect(
      renderHumanEvent(
        event({
          level: "info",
          event: "command.started",
          data: { z: 1, action: "test" },
        }),
      ),
    ).toEqual({
      stdout: 'command.started {"action":"test","z":1}\n',
      stderr: "",
    });
  });

  it.each(["debug", "warn", "error"] as const)(
    "renders %s events to stderr",
    (level) => {
      expect(
        renderHumanEvent(
          event({ level, event: "error", data: { message: "failed" } }),
        ),
      ).toEqual({ stdout: "", stderr: 'error {"message":"failed"}\n' });
    },
  );

  it("does not render envelope metadata", () => {
    const original = event({
      level: "info",
      event: "execution.finished",
      data: { wallNs: "10" },
    });
    const changedMetadata = {
      ...original,
      timestampUtc: "2099-12-31T23:59:59.999Z",
      monotonicNs: "999999999999",
      runId: "another-run",
      caseId: "case-9",
      component: "other",
      problemSlug: "different",
      implementationId: "implementation-2",
    } as Event;

    expect(renderHumanEvent(changedMetadata)).toEqual(
      renderHumanEvent(original),
    );
  });

  it("bounds a complete fragment deterministically", () => {
    const result = renderHumanEvent(
      event({
        level: "warn",
        event: "fuzz.mismatch",
        data: { detail: "x".repeat(2_000) },
      }),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBe(MAX_HUMAN_FRAGMENT_LENGTH);
    expect(result.stderr).toContain(" ...[truncated]\n");
  });
});
