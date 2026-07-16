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
  createTelemetryEvent,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventFactory,
} from "./event.js";
export type { TelemetryWarningReporter } from "./publisher.js";
export { publishSafely } from "./publisher.js";
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
export type { HumanOutputFragments } from "./render/human.js";
export { MAX_HUMAN_FRAGMENT_LENGTH, renderHumanEvent } from "./render/human.js";
