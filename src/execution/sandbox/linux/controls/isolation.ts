/**
 * Namespace / privilege isolation controls (optional defense in depth).
 *
 * These controls wrap the target with `unshare` and `setpriv` (util-linux) to
 * add kernel isolation on top of the authoritative cgroup + wall deadline:
 *
 * - {@link createNamespacesControl} runs the child in fresh user, mount, PID,
 *   and network namespaces (with a private `/proc`). The empty network namespace
 *   denies network access, and the mount namespace keeps mount changes private
 *   to the child; the user namespace lets this work without real privileges on
 *   hosts that permit unprivileged user namespaces.
 * - {@link createNoNewPrivilegesControl} sets `PR_SET_NO_NEW_PRIVS` and clears
 *   the capability bounding set via `setpriv`, so the child can never gain
 *   privileges through set-uid binaries.
 *
 * Both are optional by default: when the tool or the unprivileged-userns
 * capability is missing, the control probes as unavailable and is skipped,
 * leaving the run in a degraded (but still cgroup-bounded) mode. Seccomp is
 * deliberately not implemented here — it is optional and insufficient alone, and
 * a CLI seam for it is not portable.
 *
 * This is an adapter module and may use Node builtins.
 */

import { readFile } from "node:fs/promises";

import type {
  ControlContext,
  ControlProbe,
  InstalledControl,
  SandboxControl,
} from "./control.js";
import { resolveTool } from "./tools.js";

/** A teardown that reverses nothing (wrappers leave no host state). */
async function noTeardown(): Promise<readonly string[]> {
  return [];
}

/**
 * Decide whether the host lets an unprivileged process create user namespaces.
 *
 * Root can always unshare; otherwise the Debian/Ubuntu
 * `kernel.unprivileged_userns_clone` toggle (when present) must be enabled. On
 * kernels without that knob, unprivileged user namespaces are assumed available.
 */
async function canUseUserNamespaces(): Promise<boolean> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return true;
  }
  try {
    const raw = await readFile(
      "/proc/sys/kernel/unprivileged_userns_clone",
      "utf8",
    );
    return raw.trim() === "1";
  } catch {
    // The knob does not exist on this kernel; assume userns is permitted.
    return true;
  }
}

/**
 * Create the namespace-isolation control (`unshare`).
 *
 * @param required - Whether the run must fail closed without namespaces.
 *   Defaults to `false`.
 * @returns A {@link SandboxControl}.
 */
export function createNamespacesControl(required = false): SandboxControl {
  return {
    id: "namespaces",
    required,

    async probe(): Promise<ControlProbe> {
      if (process.platform !== "linux") {
        return { available: false, reason: "namespaces require Linux" };
      }
      const tool = await resolveTool("unshare");
      if (tool === null) {
        return { available: false, reason: "unshare not found in system paths" };
      }
      if (!(await canUseUserNamespaces())) {
        return {
          available: false,
          reason: "unprivileged user namespaces are disabled on this host",
        };
      }
      return { available: true };
    },

    async install(_context: ControlContext): Promise<InstalledControl> {
      const tool = await resolveTool("unshare");
      if (tool === null) {
        throw new Error("unshare disappeared between probe and install");
      }
      return {
        // Fresh user (mapped to root inside), mount, PID (with private /proc),
        // and empty network namespaces; `--fork` so the child becomes PID 1 of
        // its PID namespace and its descendants are contained.
        argvPrefix: [
          tool,
          "--user",
          "--map-root-user",
          "--mount",
          "--pid",
          "--fork",
          "--mount-proc",
          "--net",
          "--",
        ],
        teardown: noTeardown,
      };
    },
  };
}

/**
 * Create the no-new-privileges + capability-drop control (`setpriv`).
 *
 * @param required - Whether the run must fail closed without `setpriv`. Defaults
 *   to `false`.
 * @returns A {@link SandboxControl}.
 */
export function createNoNewPrivilegesControl(required = false): SandboxControl {
  return {
    id: "no-new-privileges",
    required,

    async probe(): Promise<ControlProbe> {
      if (process.platform !== "linux") {
        return { available: false, reason: "setpriv requires Linux" };
      }
      const tool = await resolveTool("setpriv");
      return tool === null
        ? { available: false, reason: "setpriv not found in system paths" }
        : { available: true };
    },

    async install(_context: ControlContext): Promise<InstalledControl> {
      const tool = await resolveTool("setpriv");
      if (tool === null) {
        throw new Error("setpriv disappeared between probe and install");
      }
      return {
        // Forbid privilege escalation and empty the capability bounding set so
        // the target cannot regain capabilities.
        argvPrefix: [tool, "--no-new-privs", "--bounding-set", "-all", "--"],
        teardown: noTeardown,
      };
    },
  };
}
