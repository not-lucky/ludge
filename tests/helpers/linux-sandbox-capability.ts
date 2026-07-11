/**
 * Shared test helpers for the capability-gated Linux sandbox suites.
 *
 * Full-enforcement sandbox behaviour can only be exercised on Linux with a
 * writable, delegated cgroup v2 parent. These helpers discover that capability
 * once and provide a trivial manually-triggerable {@link CancellationToken} so
 * both the integration suite and the port contract suite can gate identically
 * and stay green (skipped) on hosts without the capability.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import type { CancellationToken } from "../../src/execution/ports/index.js";

/**
 * Discover a writable cgroup v2 parent the test user may create children under,
 * or `null` when full enforcement cannot be exercised on this host.
 *
 * Honors `PALESTRA_TEST_CGROUP_PARENT` as an explicit override, otherwise maps
 * this process's own unified cgroup (from `/proc/self/cgroup`) into
 * `/sys/fs/cgroup` and confirms a child cgroup can actually be created there.
 */
export function discoverCgroupParent(): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  const candidates: string[] = [];
  const override = process.env["PALESTRA_TEST_CGROUP_PARENT"];
  if (override !== undefined && override.length > 0) {
    candidates.push(override);
  }
  try {
    const selfCgroup = readFileSync("/proc/self/cgroup", "utf8");
    const line = selfCgroup.split("\n").find((l) => l.startsWith("0::"));
    if (line !== undefined) {
      candidates.push(join("/sys/fs/cgroup", line.slice("0::".length)));
    }
  } catch {
    // /proc unavailable; rely on any override only.
  }

  for (const parent of candidates) {
    if (!existsSync(join(parent, "cgroup.controllers"))) {
      continue;
    }
    const probe = join(parent, `palestra-probe-${process.pid}`);
    try {
      mkdirSync(probe);
      rmdirSync(probe);
      return parent;
    } catch {
      continue;
    }
  }
  return null;
}

/** The discovered delegated cgroup v2 parent, or `null` when unavailable. */
export const CGROUP_PARENT = discoverCgroupParent();

/** Whether full-enforcement sandbox tests can run on this host. */
export const CAN_ENFORCE = CGROUP_PARENT !== null;

/** A trivial, imperatively-triggerable {@link CancellationToken} for tests. */
export class ManualCancellation implements CancellationToken {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  public get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  public onCancel(listener: () => void): () => void {
    if (this.cancelled) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public throwIfCancellationRequested(): void {
    if (this.cancelled) {
      throw new Error("cancelled");
    }
  }

  public cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
