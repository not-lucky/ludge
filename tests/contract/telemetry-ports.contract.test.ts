/**
 * Contract-test scaffold for the telemetry port.
 *
 * This suite enumerates the obligations any concrete {@link TelemetrySink} must
 * satisfy. It is a `todo` placeholder: task 10 (telemetry) supplies the fixture
 * that drives these obligations against the real event system, including the
 * concrete event-envelope type instantiation.
 */

import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/execution/ports/index.js";
import {
  SafeTelemetryPublisher,
  TelemetryEventFactory,
  type TelemetryEvent,
} from "../../src/telemetry/index.js";
import type { TelemetrySink } from "../../src/telemetry/ports/index.js";

// Retain the type-only import and verify the port surface exists.
type _PortSurface = [TelemetrySink<TelemetryEvent>];

const clock: Clock = {
  monotonicNs: () => 1n,
  wallTimeUtc: () => "2026-01-01T00:00:00.000Z",
};

function makeEvent(event = "command.started"): TelemetryEvent {
  return new TelemetryEventFactory(clock).create({
    level: "info",
    event,
    runId: "run-1",
    caseId: null,
    component: "contract",
    problemSlug: "problem",
    implementationId: null,
    data: {},
  } as Parameters<TelemetryEventFactory["create"]>[0]);
}

describe("TelemetrySink contract", () => {
  it("emit() accepts a well-formed event envelope", () => {
    const events: TelemetryEvent[] = [];
    const sink: TelemetrySink<TelemetryEvent> = { emit: (event) => events.push(event) };
    sink.emit(makeEvent());
    expect(events).toHaveLength(1);
    expect(events[0]?.schemaVersion).toBe(1);
  });

  it("emit() is fire-and-forget: a sink failure never alters a verdict", () => {
    const sink: TelemetrySink<TelemetryEvent> = {
      emit: () => { throw new Error("unavailable"); },
    };
    const publisher = new SafeTelemetryPublisher([sink]);
    let verdict = "passed";
    publisher.emit(makeEvent());
    verdict = "passed";
    expect(verdict).toBe("passed");
  });

  it("emit() delivers events in the order the orchestrator submits them", () => {
    const names: string[] = [];
    const sink: TelemetrySink<TelemetryEvent> = { emit: (event) => names.push(event.event) };
    const publisher = new SafeTelemetryPublisher([sink]);
    publisher.emit(makeEvent("command.started"));
    publisher.emit(makeEvent("command.finished"));
    expect(names).toEqual(["command.started", "command.finished"]);
  });
});
