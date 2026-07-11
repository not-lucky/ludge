/**
 * Public surface of the `python-uv` runtime adapter.
 *
 * The composition root (task 11) imports the adapter factory and configuration
 * builder from here to register the Python backend's runtime component; the
 * shipped Python harness under `harness/` is a data asset, not a module exported
 * from this barrel.
 */

// Configuration.
export { createPythonRuntimeConfig } from "./config.js";
export type {
  PythonRuntimeConfig,
  PythonRuntimeConfigSpec,
} from "./config.js";

// Launch plan value type.
export type { PythonLaunchPlan } from "./launch-plan.js";

// Shipped-asset resolution.
export { defaultHarnessEntrypoint } from "./assets.js";

// Runtime descriptor.
export { PYTHON_UV_RUNTIME_ID, pythonUvDescriptor } from "./descriptor.js";

// The adapter factory and its extended interface.
export { createPythonRuntimeAdapter } from "./adapter.js";
export type { PythonRuntimeAdapter } from "./adapter.js";
