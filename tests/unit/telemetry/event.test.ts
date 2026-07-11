import { describe, expect, it } from "vitest";
import type { Clock } from "../../../src/execution/ports/index.js";
import {
  assertTelemetryEvent,
  isTelemetryEvent,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventFactory,
} from "../../../src/telemetry/index.js";

const clock: Clock = {
  monotonicNs: () => 9_007_199_254_740_993n,
  wallTimeUtc: () => "2026-01-01T00:00:00.000Z",
};

describe("TelemetryEventFactory", () => {
  it("creates a schema-v1 envelope without losing monotonic precision", () => {
    const event = new TelemetryEventFactory(clock).create({
      level: "info",
      event: "command.started",
      runId: "run-1",
      caseId: null,
      component: "test",
      problemSlug: "two-sum",
      implementationId: null,
      data: { command: "test" },
    });

    expect(event).toEqual({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestampUtc: "2026-01-01T00:00:00.000Z",
      monotonicNs: "9007199254740993",
      level: "info",
      event: "command.started",
      runId: "run-1",
      caseId: null,
      component: "test",
      problemSlug: "two-sum",
      implementationId: null,
      data: { command: "test" },
    });
  });

  it("requires a generation for watch facts", () => {
    const factory = new TelemetryEventFactory(clock);
    expect(() => factory.create({
      level: "info",
      event: "watch.change",
      runId: "run-1",
      caseId: null,
      component: "watch",
      problemSlug: "two-sum",
      implementationId: null,
      data: {},
    })).toThrow("require a generation");
  });

  it("rejects invalid envelopes without throwing from the predicate", () => {
    const invalid = {
      schemaVersion: 1,
      timestampUtc: "not a timestamp",
      monotonicNs: "-1",
    };
    expect(isTelemetryEvent(invalid)).toBe(false);
    expect(() => assertTelemetryEvent(invalid)).toThrow(RangeError);
  });
});
