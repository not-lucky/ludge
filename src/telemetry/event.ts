import type { Clock } from "../execution/clock.js";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export type TelemetryLevel = "debug" | "info" | "warn" | "error";
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
export type TelemetryValue =
  | null
  | boolean
  | number
  | string
  | readonly TelemetryValue[]
  | { readonly [key: string]: TelemetryValue };
export type TelemetryData = Readonly<Record<string, TelemetryValue>>;

export interface TelemetryCorrelation {
  readonly runId: string;
  readonly caseId: string | null;
  readonly component: string;
  readonly problemSlug: string;
  readonly implementationId: string | null;
  readonly generation?: number;
}
export interface TelemetryEvent extends TelemetryCorrelation {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly timestampUtc: string;
  readonly monotonicNs: string;
  readonly level: TelemetryLevel;
  readonly event: TelemetryEventName;
  readonly data: TelemetryData;
}
export interface CreateTelemetryEvent extends TelemetryCorrelation {
  readonly level: TelemetryLevel;
  readonly event: TelemetryEventName;
  readonly data: TelemetryData;
}

/** Events are internal typed facts; validate untrusted data before it reaches here. */
export function createTelemetryEvent(
  clock: Clock,
  input: CreateTelemetryEvent,
): TelemetryEvent {
  return {
    ...input,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    timestampUtc: clock.wallTimeUtc(),
    monotonicNs: clock.monotonicNs().toString(),
  };
}

/** Compatibility wrapper for existing composition code. */
export class TelemetryEventFactory {
  public constructor(private readonly clock: Clock) {}
  public create(input: CreateTelemetryEvent): TelemetryEvent {
    return createTelemetryEvent(this.clock, input);
  }
}
