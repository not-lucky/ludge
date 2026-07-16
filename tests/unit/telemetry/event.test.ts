import { describe, expect, it } from "vitest";
import type { Clock } from "../../../src/execution/clock.js";
import {
  createTelemetryEvent,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventFactory,
} from "../../../src/telemetry/index.js";

const clock: Clock = {
  monotonicNs: () => 9_007_199_254_740_993n,
  wallTimeUtc: () => "2026-01-01T00:00:00.000Z",
};

const input = {
  level: "info" as const,
  event: "command.started" as const,
  runId: "run-1",
  caseId: null,
  component: "test",
  problemSlug: "two-sum",
  implementationId: null,
  data: { command: "test" },
};

describe("telemetry events", () => {
  it("stamps typed internal facts without losing monotonic precision", () => {
    expect(createTelemetryEvent(clock, input)).toMatchObject({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestampUtc: "2026-01-01T00:00:00.000Z",
      monotonicNs: "9007199254740993",
      ...input,
    });
  });

  it("keeps the small factory wrapper for composition code", () => {
    expect(new TelemetryEventFactory(clock).create(input)).toEqual(
      createTelemetryEvent(clock, input),
    );
  });
});
