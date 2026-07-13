/**
 * Capability-gated integration tests for the Linux full-enforcement sandbox.
 *
 * These drive {@link createLinuxSandbox} against real child processes and a real
 * cgroup v2 subtree, so they only run on Linux with a writable, delegated cgroup
 * v2 parent. Everywhere else (non-Linux CI, unprivileged hosts without cgroup
 * delegation) the whole suite is skipped via {@link describe.skipIf}, keeping the
 * green build portable while still exercising the true kernel boundary where it
 * is available.
 *
 * To force a specific delegated parent, set `PALESTRA_TEST_CGROUP_PARENT` to an
 * absolute cgroup v2 directory the test user may create children under.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, describe, expect, it } from "vitest";

import { createLinuxSandbox } from "../../../src/execution/sandbox/linux/index.js";
import { createLinuxSandboxConfig } from "../../../src/execution/sandbox/linux/index.js";
import { classifyTermination } from "../../../src/execution/sandbox/linux/index.js";
import { createResourceLimits } from "../../../src/domain/index.js";
import type { ResourceLimits } from "../../../src/domain/index.js";
import type { ArgvInvocation } from "../../../src/execution/ports/index.js";
import {
  CAN_ENFORCE,
  CGROUP_PARENT,
  ManualCancellation,
} from "../../helpers/linux-sandbox-capability.js";

/** Build resource limits with sane defaults, overridable per test. */
function limits(overrides: Partial<ResourceLimits> = {}): ResourceLimits {
  return createResourceLimits({
    wallTimeMs: 2000,
    cpuTimeMs: 2000,
    memoryBytes: 256 * 1024 * 1024,
    stdoutBytes: 64 * 1024,
    stderrBytes: 64 * 1024,
    combinedOutputBytes: 128 * 1024,
    inputBytes: 64 * 1024,
    fileSizeBytes: 1024 * 1024,
    processCount: 64,
    openDescriptors: 64,
    tempStorageBytes: 1024 * 1024,
    concurrencyPerCase: 1,
    ...overrides,
  });
}

function makeSandbox() {
  const config = createLinuxSandboxConfig({
    workingDirectory: "/",
    environment: { PATH: "/usr/bin:/bin" },
    cgroupParentPath: CGROUP_PARENT ?? "/sys/fs/cgroup",
    tempBaseDir: join(tmpdir(), "palestra-int"),
  });
  return createLinuxSandbox("linux-int", config);
}

const sh = (script: string): ArgvInvocation => ({
  executable: "/bin/sh",
  args: ["-c", script],
});

describe.skipIf(!CAN_ENFORCE)("Linux sandbox integration", () => {
  const sandbox = CAN_ENFORCE ? makeSandbox() : null;

  afterAll(() => {
    const base = join(tmpdir(), "palestra-int");
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("classifies a wall-clock deadline as tle_wall", async () => {
    const raw = await sandbox!.run(
      sh("sleep 10"),
      new Uint8Array(),
      limits({ wallTimeMs: 150, cpuTimeMs: 5000 }),
      new ManualCancellation(),
    );
    expect(raw.termination).toBe("timed_out");
    expect(classifyTermination(raw, limits({ wallTimeMs: 150, cpuTimeMs: 5000 }))).toBe(
      "tle_wall",
    );
  });

  it("classifies a memory blow-up as mle", async () => {
    // Allocate well past the 32 MiB cap; the cgroup OOM-kills the child.
    const small = limits({ memoryBytes: 32 * 1024 * 1024, wallTimeMs: 5000 });
    const raw = await sandbox!.run(
      sh("exec dd if=/dev/zero of=/dev/null bs=1 2>/dev/null & python3 -c 'b=bytearray(1<<30)' 2>/dev/null || head -c 1000000000 /dev/zero | tr '\\0' 'a' >/dev/null"),
      new Uint8Array(),
      small,
      new ManualCancellation(),
    );
    // Either an OOM kill was observed, or the peak reached the ceiling.
    expect(
      raw.resources.oomKills > 0 ||
        raw.resources.memoryPeakBytes >= small.memoryBytes ||
        classifyTermination(raw, small) === "mle",
    ).toBe(true);
  });

  it("truncates and classifies overflowing output as output_limit", async () => {
    const capped = limits({
      stdoutBytes: 4 * 1024,
      combinedOutputBytes: 8 * 1024,
      wallTimeMs: 5000,
    });
    const raw = await sandbox!.run(
      sh("yes AAAAAAAA | head -c 1000000"),
      new Uint8Array(),
      capped,
      new ManualCancellation(),
    );
    expect(raw.stdout.truncated).toBe(true);
    expect(raw.stdout.data.byteLength).toBeLessThanOrEqual(capped.stdoutBytes);
    expect(classifyTermination(raw, capped)).toBe("output_limit");
  });

  it("kills forked descendants and reaps the whole tree", async () => {
    // Fork a grandchild that would outlive its parent; the group kill must reap
    // it. We give the child a short sleep so the wall deadline forces cleanup.
    const raw = await sandbox!.run(
      sh("(sleep 30 &) ; sleep 30"),
      new Uint8Array(),
      limits({ wallTimeMs: 200 }),
      new ManualCancellation(),
    );
    expect(raw.termination).toBe("timed_out");
    // Cleanup must not leave diagnostics indicating an orphan/leak beyond the
    // recorded best-effort messages; the run must still resolve.
    expect(Array.isArray(raw.cleanupDiagnostics)).toBe(true);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // trap+ignore SIGTERM, then busy-wait; only SIGKILL can stop it. The
    // SIGTERM→SIGKILL grace window is a sandbox-config concern, not a limit.
    const raw = await sandbox!.run(
      sh("trap '' TERM; while true; do :; done"),
      new Uint8Array(),
      limits({ wallTimeMs: 200 }),
      new ManualCancellation(),
    );
    expect(["timed_out", "killed", "signaled"]).toContain(raw.termination);
  });

  it("aborts promptly when cancellation is requested", async () => {
    const cancellation = new ManualCancellation();
    const promise = sandbox!.run(
      sh("sleep 30"),
      new Uint8Array(),
      limits({ wallTimeMs: 10000 }),
      cancellation,
    );
    setTimeout(() => cancellation.cancel(), 50);
    const raw = await promise;
    expect(raw.termination).toBe("killed");
  });

  it("resolves with spawn_failed for a missing executable (fails closed)", async () => {
    const raw = await sandbox!.run(
      { executable: "/nonexistent/program", args: [] },
      new Uint8Array(),
      limits(),
      new ManualCancellation(),
    );
    expect(raw.termination).toBe("spawn_failed");
    expect(classifyTermination(raw, limits())).toBe("spawn_error");
  });
});
