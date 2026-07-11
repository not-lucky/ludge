/** Node JSON Lines adapter for structured telemetry output. */

import type { Writable } from "node:stream";
import type { TelemetryEvent } from "../event.js";
import type { TelemetrySink } from "../ports/index.js";

/** Write each event as exactly one JSON Lines record. */
export class JsonlTelemetrySink implements TelemetrySink<TelemetryEvent> {
  /**
   * @param output - Destination stream selected by the composition root.
   */
  public constructor(private readonly output: Writable) {}

  /** Serialize and write one schema-v1 event. Stream failures are contained by the publisher. */
  public emit(event: TelemetryEvent): void {
    this.output.write(`${JSON.stringify(event)}\n`);
  }
}
