import { describe, expect, it } from "vitest";
import {
  publishSafely,
  type TelemetryEvent,
} from "../../../src/telemetry/index.js";
import type { TelemetrySink } from "../../../src/telemetry/ports/sink.js";

const event: TelemetryEvent = {
  schemaVersion: 1,
  timestampUtc: "2026-01-01T00:00:00.000Z",
  monotonicNs: "0",
  level: "info",
  event: "command.finished",
  runId: "run-1",
  caseId: null,
  component: "test",
  problemSlug: "two-sum",
  implementationId: null,
  data: {},
};

describe("publishSafely", () => {
  it("delivers facts in submit order", () => {
    const received: string[] = [];
    const sink: TelemetrySink<TelemetryEvent> = {
      emit: (item) => received.push(item.event),
    };
    publishSafely([sink], event);
    publishSafely([sink], { ...event, event: "execution.finished" });
    expect(received).toEqual(["command.finished", "execution.finished"]);
  });

  it("contains observer failures", () => {
    const warnings: string[] = [];
    const throwing: TelemetrySink<TelemetryEvent> = {
      emit: () => {
        throw new Error("sink unavailable");
      },
    };
    publishSafely([throwing], event, (warning) =>
      warnings.push(warning.message),
    );
    expect(warnings).toEqual(["telemetry sink failed: sink unavailable"]);
  });
});
