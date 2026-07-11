import { describe, expect, it } from "vitest";
import type { TelemetryEvent } from "../../../src/telemetry/index.js";
import { SafeTelemetryPublisher } from "../../../src/telemetry/index.js";
import type { TelemetrySink } from "../../../src/telemetry/ports/index.js";

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

describe("SafeTelemetryPublisher", () => {
  it("delivers facts in submit order", () => {
    const received: string[] = [];
    const sink: TelemetrySink<TelemetryEvent> = { emit: (item) => received.push(item.event) };
    const publisher = new SafeTelemetryPublisher([sink]);

    publisher.emit(event);
    publisher.emit({ ...event, event: "execution.finished" });

    expect(received).toEqual(["command.finished", "execution.finished"]);
  });

  it("contains observer failures and reports a bounded warning", () => {
    const warnings: string[] = [];
    const throwing: TelemetrySink<TelemetryEvent> = {
      emit: () => { throw new Error("sink unavailable"); },
    };
    let verdict = "passed";
    const publisher = new SafeTelemetryPublisher([throwing], (warning) => warnings.push(warning.message));

    publisher.emit(event);
    verdict = "passed";

    expect(verdict).toBe("passed");
    expect(warnings).toEqual(["telemetry sink failed: sink unavailable"]);
  });
});
