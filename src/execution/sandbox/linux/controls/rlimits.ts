/**
 * Rlimit control — defense-in-depth resource ceilings.
 *
 * This control wraps the target with `prlimit` (from util-linux) so the kernel
 * enforces per-process rlimits that corroborate the authoritative cgroup + wall
 * deadline: `RLIMIT_CPU` (→ `SIGXCPU`), `RLIMIT_AS`, `RLIMIT_FSIZE` (→ `SIGXFSZ`
 * on a write past the file ceiling), `RLIMIT_NOFILE`, and `RLIMIT_NPROC`. Two of
 * these produce the only reliable in-band evidence the classifier has for
 * `tle_cpu` and `file_limit`, so the wrapper earns its place even though it is
 * never the sole mechanism.
 *
 * The control probes for `prlimit`; when it is absent the control (optional by
 * default) is skipped and the run proceeds in degraded mode with the cgroup and
 * wall deadline still authoritative.
 *
 * This is an adapter module and may use Node builtins.
 */

import type {
  ControlContext,
  ControlProbe,
  InstalledControl,
  SandboxControl,
} from "./control.js";
import { resolveTool } from "./tools.js";

/**
 * Build the `prlimit` argv flags for a set of resource limits.
 *
 * `RLIMIT_CPU` is expressed in whole seconds (rounded up so a sub-second CPU
 * budget still yields at least one second of headroom before the signal). Byte
 * ceilings pass through verbatim.
 */
function prlimitFlags(context: ControlContext): string[] {
  const { limits } = context;
  const cpuSeconds = Math.max(1, Math.ceil(limits.cpuTimeMs / 1000));
  return [
    `--cpu=${cpuSeconds}`,
    `--as=${limits.memoryBytes}`,
    `--fsize=${limits.fileSizeBytes}`,
    `--nofile=${limits.openDescriptors}`,
    `--nproc=${limits.processCount}`,
  ];
}

/**
 * Create the rlimit (`prlimit`) defense-in-depth control.
 *
 * @param required - Whether the run must fail closed without `prlimit`. Defaults
 *   to `false`: the cgroup and wall deadline remain authoritative.
 * @returns A {@link SandboxControl}.
 */
export function createRlimitControl(required = false): SandboxControl {
  return {
    id: "rlimits",
    required,

    async probe(): Promise<ControlProbe> {
      if (process.platform !== "linux") {
        return { available: false, reason: "rlimit wrapper requires Linux" };
      }
      const tool = await resolveTool("prlimit");
      return tool === null
        ? { available: false, reason: "prlimit not found in system paths" }
        : { available: true };
    },

    async install(context: ControlContext): Promise<InstalledControl> {
      const tool = await resolveTool("prlimit");
      if (tool === null) {
        // Should not happen after a successful probe, but stay defensive.
        throw new Error("prlimit disappeared between probe and install");
      }
      return {
        // `prlimit <flags> -- <target...>`: the `--` terminates prlimit options.
        argvPrefix: [tool, ...prlimitFlags(context), "--"],
        async teardown(): Promise<readonly string[]> {
          // A wrapper leaves no host state to reverse.
          return [];
        },
      };
    },
  };
}
