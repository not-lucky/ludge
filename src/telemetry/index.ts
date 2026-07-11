/** Public schema-v1 telemetry surface. */

export type {
  CreateTelemetryEvent,
  TelemetryCorrelation,
  TelemetryData,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryLevel,
  TelemetryValue,
} from "./event.js";
export {
  assertTelemetryEvent,
  isTelemetryEvent,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventFactory,
} from "./event.js";
export type { TelemetryWarning, TelemetryWarningReporter } from "./publisher.js";
export { MAX_TELEMETRY_WARNING_LENGTH, SafeTelemetryPublisher } from "./publisher.js";
export type { TelemetryRedactionPolicy } from "./redaction.js";
export {
  DEFAULT_TELEMETRY_DEPTH_LIMIT,
  DEFAULT_TELEMETRY_TEXT_LIMIT,
  normalizeProblemPath,
  redactInput,
  redactTelemetryData,
  TELEMETRY_ENVIRONMENT_ALLOW_LIST,
} from "./redaction.js";
export type {
  ExecutionProfile,
  ExecutionProfileFacts,
  ExecutionProfileOutcome,
} from "./profile.js";
export {
  createExecutionProfiler,
  EXECUTION_PROFILE_SCHEMA_VERSION,
} from "./profile.js";
export type { HumanOutputFragments } from "./render/index.js";
export { MAX_HUMAN_FRAGMENT_LENGTH, renderHumanEvent } from "./render/index.js";
