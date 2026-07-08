/**
 * Contract-test scaffold for the telemetry port.
 *
 * This suite enumerates the obligations any concrete {@link TelemetrySink} must
 * satisfy. It is a `todo` placeholder: task 10 (telemetry) supplies the fixture
 * that drives these obligations against the real event system, including the
 * concrete event-envelope type instantiation.
 */

import { describe, it } from "vitest";
import type { TelemetrySink } from "../../src/telemetry/ports/index.js";

// Retain the type-only import and verify the port surface exists.
type _PortSurface = [TelemetrySink];

describe("TelemetrySink contract", () => {
  it.todo("emit() accepts a well-formed event envelope");
  it.todo("emit() is fire-and-forget: a sink failure never alters a verdict");
  it.todo("emit() delivers events in the order the orchestrator submits them");
});
