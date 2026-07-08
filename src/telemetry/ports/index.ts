/**
 * Public surface of the telemetry ports layer.
 *
 * These ports declare the adapter-free seams through which the system
 * publishes structured telemetry. They import only from the pure domain and
 * sibling port modules — no runtime, adapter, CLI, Node, or third-party
 * dependency. Downstream layers import from this barrel rather than reaching
 * into individual files.
 */

// Telemetry sink observer seam.
export type { TelemetrySink } from "./sink.js";
