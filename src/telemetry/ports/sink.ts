/**
 * Telemetry sink port: the observer seam for structured events.
 *
 * This module is pure: no runtime, adapter, or Node import. It declares the
 * observer seam through which the system publishes structured telemetry
 * events, so producers depend on this contract rather than a concrete adapter.
 */

/**
 * A sink that receives structured telemetry events.
 *
 * `TEvent` is the event envelope defined by task 10 (schemaVersion 1); task 03
 * fixes only the contract so producers depend on the port, not a concrete
 * adapter. It is left generic here because task 03 must not anticipate the
 * concrete envelope shape.
 */
export interface TelemetrySink<TEvent = unknown> {
  /**
   * Publish a telemetry event.
   *
   * Emission is fire-and-forget and MUST be non-throwing in spirit:
   * telemetry/logging failures MUST NOT alter a target verdict (they are
   * surfaced as warnings elsewhere). Observers receive facts AFTER the
   * orchestrator owns ordering; telemetry is never correctness-critical
   * (Observer pattern; observers do not enforce ordering).
   */
  emit(event: TEvent): void;
}
