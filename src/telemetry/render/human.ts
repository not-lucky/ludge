/** Event-only renderer for human command output. */

import type { TelemetryEvent, TelemetryEventName } from "../event.js";

/** Maximum number of characters in one rendered stream fragment. */
export const MAX_HUMAN_FRAGMENT_LENGTH = 1_024;

/** The streams to write after rendering one telemetry event. */
export interface HumanOutputFragments {
  readonly stdout: string;
  readonly stderr: string;
}

const TRUNCATION_MARKER = " ...[truncated]";

/**
 * Render one telemetry fact for a human-facing command stream.
 *
 * The renderer intentionally reads only `level`, `event`, and `data`: envelope
 * metadata remains available for structured consumers, but cannot affect what
 * is presented to a person. In particular, this function does not infer or
 * translate a status from any execution details.
 */
export function renderHumanEvent(event: TelemetryEvent): HumanOutputFragments {
  const eventName: TelemetryEventName = event.event;
  const data = stableJson(event.data);
  const fragment = limit(`${eventName}${data === "{}" ? "" : ` ${data}`}\n`);

  // Info events are command summaries; all other levels are diagnostics/logs.
  return event.level === "info"
    ? { stdout: fragment, stderr: "" }
    : { stdout: "", stderr: fragment };
}

/** Serialize JSON-like telemetry data with a deterministic object-key order. */
function stableJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(",")}]`;
      }

      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
        .join(",")}}`;
    default:
      // Event data is JSON by contract. This fallback keeps rendering total for
      // malformed producer input without turning it into a classification.
      return "null";
  }
}

/** Keep the complete stream fragment bounded, including its truncation marker. */
function limit(text: string): string {
  if (text.length <= MAX_HUMAN_FRAGMENT_LENGTH) {
    return text;
  }

  const contentLimit = MAX_HUMAN_FRAGMENT_LENGTH - TRUNCATION_MARKER.length - 1;
  return `${text.slice(0, contentLimit)}${TRUNCATION_MARKER}\n`;
}
