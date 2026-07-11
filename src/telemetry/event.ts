/**
 * Schema-v1 structured telemetry events.
 *
 * Events are observations emitted after the orchestrator has decided their
 * order. They are deliberately independent from verdict calculation: an event
 * carries facts for observers but never feeds a decision back into a run.
 */

import type { Clock } from "../execution/ports/index.js";

/** The only schema version currently accepted by telemetry consumers. */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/** Severity assigned to an observed telemetry fact. */
export type TelemetryLevel = "debug" | "info" | "warn" | "error";

/** Event literals defined by the schema-v1 observability contract. */
export type TelemetryEventName =
  | "command.started"
  | "command.finished"
  | "execution.spawned"
  | "execution.sampled"
  | "execution.terminated"
  | "execution.finished"
  | "sandbox.control"
  | "fuzz.case"
  | "fuzz.mismatch"
  | "fuzz.shrink"
  | "watch.change"
  | "watch.cancel"
  | "benchmark.sample"
  | "persistence.commit"
  | "error";

/** A value that can be encoded in a schema-v1 event's `data` object. */
export type TelemetryValue =
  | null
  | boolean
  | number
  | string
  | readonly TelemetryValue[]
  | { readonly [key: string]: TelemetryValue };

/** JSON-object payload attached to a telemetry event. */
export type TelemetryData = Readonly<Record<string, TelemetryValue>>;

/** Correlation fields supplied by the orchestrator for an event. */
export interface TelemetryCorrelation {
  /** Identifier for the command/run that owns the event. */
  readonly runId: string;
  /** Identifier of the active case, or `null` for command-level events. */
  readonly caseId: string | null;
  /** Component publishing the fact, such as `test` or `linux-sandbox`. */
  readonly component: string;
  /** Stable slug of the problem being observed. */
  readonly problemSlug: string;
  /** Implementation identity, or `null` when no implementation is involved. */
  readonly implementationId: string | null;
  /** Watch generation; required for `watch.*` events. */
  readonly generation?: number;
}

/** The complete versioned telemetry event envelope. */
export interface TelemetryEvent extends TelemetryCorrelation {
  /** Version of this envelope shape. */
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  /** RFC-3339 UTC timestamp with a `Z` offset. */
  readonly timestampUtc: string;
  /** Non-negative monotonic nanoseconds represented as decimal text. */
  readonly monotonicNs: string;
  /** Event severity. */
  readonly level: TelemetryLevel;
  /** Literal naming the observed fact. */
  readonly event: TelemetryEventName;
  /** Event-specific, already-redacted JSON data. */
  readonly data: TelemetryData;
}

/** Input used to create one timestamped event with a shared correlation. */
export interface CreateTelemetryEvent extends TelemetryCorrelation {
  /** Event severity. */
  readonly level: TelemetryLevel;
  /** Literal naming the observed fact. */
  readonly event: TelemetryEventName;
  /** Event-specific, already-redacted JSON data. */
  readonly data: TelemetryData;
}

/** Create valid schema-v1 event envelopes from an injected clock. */
export class TelemetryEventFactory {
  /**
   * @param clock - Wall and monotonic clock used to timestamp emitted facts.
   */
  public constructor(private readonly clock: Clock) {}

  /**
   * Stamp and validate an event envelope.
   *
   * @param input - Correlation, event name, level, and safe event payload.
   * @returns A schema-v1 event ready for ordered publication.
   * @throws {RangeError} If structural fields violate the schema contract.
   */
  public create(input: CreateTelemetryEvent): TelemetryEvent {
    const event: TelemetryEvent = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestampUtc: this.clock.wallTimeUtc(),
      monotonicNs: this.clock.monotonicNs().toString(10),
      level: input.level,
      event: input.event,
      runId: input.runId,
      caseId: input.caseId,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      component: input.component,
      problemSlug: input.problemSlug,
      implementationId: input.implementationId,
      data: input.data,
    };
    assertTelemetryEvent(event);
    return Object.freeze(event);
  }
}

/** Verify that an unknown value has the schema-v1 event envelope shape. */
export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  try {
    assertTelemetryEvent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate schema-v1 event constraints before a sink observes the event.
 *
 * @param value - Event candidate to validate.
 * @throws {RangeError} If the candidate is not a valid schema-v1 event.
 */
export function assertTelemetryEvent(value: unknown): asserts value is TelemetryEvent {
  if (!isObject(value)) {
    throw new RangeError("telemetry event must be an object");
  }
  if (value.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    throw new RangeError("telemetry schemaVersion must be 1");
  }
  if (!isUtcTimestamp(value.timestampUtc)) {
    throw new RangeError("telemetry timestampUtc must be RFC-3339 UTC text");
  }
  if (typeof value.monotonicNs !== "string" || !/^\d+$/.test(value.monotonicNs)) {
    throw new RangeError("telemetry monotonicNs must be a non-negative decimal string");
  }
  if (!isLevel(value.level) || !isEventName(value.event)) {
    throw new RangeError("telemetry level or event is not recognized");
  }
  requireNonEmpty(value.runId, "runId");
  requireNullableString(value.caseId, "caseId");
  requireNonEmpty(value.component, "component");
  requireNonEmpty(value.problemSlug, "problemSlug");
  requireNullableString(value.implementationId, "implementationId");
  if (
    value.generation !== undefined &&
    (typeof value.generation !== "number" ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0)
  ) {
    throw new RangeError("telemetry generation must be a non-negative safe integer");
  }
  if (value.event.startsWith("watch.") && value.generation === undefined) {
    throw new RangeError("watch telemetry events require a generation");
  }
  if (!isTelemetryData(value.data)) {
    throw new RangeError("telemetry data must be a finite JSON object");
  }
}

const EVENT_NAMES: ReadonlySet<string> = new Set<TelemetryEventName>([
  "command.started", "command.finished", "execution.spawned", "execution.sampled",
  "execution.terminated", "execution.finished", "sandbox.control", "fuzz.case",
  "fuzz.mismatch", "fuzz.shrink", "watch.change", "watch.cancel",
  "benchmark.sample", "persistence.commit", "error",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function isLevel(value: unknown): value is TelemetryLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function isEventName(value: unknown): value is TelemetryEventName {
  return typeof value === "string" && EVENT_NAMES.has(value);
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`telemetry ${field} must be a non-empty string`);
  }
}

function requireNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new RangeError(`telemetry ${field} must be a string or null`);
  }
}

function isTelemetryData(value: unknown): value is TelemetryData {
  return isObject(value) && isTelemetryValue(value);
}

function isTelemetryValue(value: unknown): value is TelemetryValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isTelemetryValue);
  }
  return isObject(value) && Object.values(value).every(isTelemetryValue);
}
