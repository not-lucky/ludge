/** Safe, ordered event publication for non-critical telemetry observers. */

import type { TelemetrySink } from "./ports/index.js";
import type { TelemetryEvent } from "./event.js";

/** A bounded diagnostic describing a telemetry observer failure. */
export interface TelemetryWarning {
  /** Stable warning category for callers that collect diagnostics. */
  readonly kind: "telemetry";
  /** Bounded, non-sensitive failure explanation. */
  readonly message: string;
}

/** Called when an observer fails after a fact has already been decided. */
export type TelemetryWarningReporter = (warning: TelemetryWarning) => void;

/** Maximum length of an observer failure diagnostic. */
export const MAX_TELEMETRY_WARNING_LENGTH = 256;

/**
 * Publish events to observers without allowing observer failure to escape.
 *
 * Calls are synchronous and sinks are traversed in construction order. An
 * observer receives an already-owned fact; failures only invoke the optional
 * warning reporter and never influence the caller's verdict or cleanup path.
 */
export class SafeTelemetryPublisher implements TelemetrySink<TelemetryEvent> {
  /**
   * @param sinks - Ordered event observers.
   * @param reportWarning - Optional non-throwing diagnostic collector.
   */
  public constructor(
    private readonly sinks: readonly TelemetrySink<TelemetryEvent>[],
    private readonly reportWarning: TelemetryWarningReporter = () => undefined,
  ) {}

  /** Publish one fact to every observer, containing all observer failures. */
  public emit(event: TelemetryEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch (error) {
        this.reportSafely(error);
      }
    }
  }

  private reportSafely(error: unknown): void {
    try {
      this.reportWarning({ kind: "telemetry", message: describeFailure(error) });
    } catch {
      // Diagnostics are observers too: a broken reporter cannot affect a run.
    }
  }
}

function describeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const bounded = text.slice(0, MAX_TELEMETRY_WARNING_LENGTH);
  return `telemetry sink failed: ${bounded}`;
}
