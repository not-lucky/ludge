import type { TelemetryEvent } from "./event.js";
import type { TelemetrySink } from "./ports/sink.js";

export type TelemetryWarningReporter = (warning: {
  readonly kind: "telemetry";
  readonly message: string;
}) => void;

/** Publish non-critical telemetry without letting an observer affect a verdict. */
export function publishSafely(
  sinks: readonly TelemetrySink<TelemetryEvent>[],
  event: TelemetryEvent,
  reportWarning: TelemetryWarningReporter = () => undefined,
): void {
  for (const sink of sinks) {
    try {
      sink.emit(event);
    } catch (error) {
      try {
        reportWarning({
          kind: "telemetry",
          message: `telemetry sink failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 256)}`,
        });
      } catch {
        // Observer diagnostics are non-critical too.
      }
    }
  }
}
