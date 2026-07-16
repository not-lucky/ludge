/**
 * Latest-wins watch mediator.
 *
 * This class owns correctness-sensitive ordering. Filesystem observers merely
 * call {@link WatchMediator.hint}; execution, persistence, and telemetry are
 * all invoked after the mediator has chosen a generation and slot.
 */

import {
  initialGeneration,
  nextGeneration,
  type Generation,
} from "../domain/index.js";
import type { CancellationToken } from "../execution/cancellation.js";
import type {
  WatchEventFact,
  WatchRunRequest,
  WatchRunResult,
  WatchTarget,
  WatchTargetSnapshot,
  WatchTrigger,
} from "./contracts.js";

/** Timer seam; fake clocks can invoke callbacks deterministically. */
export interface WatchTimer {
  after(milliseconds: number, callback: () => void): () => void;
}

/** Read target state and perform its 50 ms stability wait outside the mediator. */
export interface WatchSnapshotReader {
  scan(target: WatchTarget): Promise<WatchTargetSnapshot>;
  stable(
    target: WatchTarget,
    candidate: WatchTargetSnapshot,
  ): Promise<WatchTargetSnapshot | null>;
}

/** Execution and terminal-write seams selected by the application facade. */
export interface WatchMediatorDependencies {
  readonly timer: WatchTimer;
  readonly snapshots: WatchSnapshotReader;
  readonly run: (request: WatchRunRequest) => Promise<WatchRunResult>;
  readonly createRunId: () => string;
  readonly emit?: (fact: WatchEventFact) => void;
  readonly debounceMs?: number;
  readonly slots?: number;
}

interface PendingRun {
  readonly generation: Generation;
  readonly trigger: WatchTrigger;
  readonly snapshot: WatchTargetSnapshot;
  /** Allocated at schedule time so every emitted fact has a real run ID. */
  readonly runId: string;
}
interface ActiveRun extends PendingRun {
  readonly cancellation: LocalCancellation;
}
interface TargetState {
  readonly target: WatchTarget;
  generation: Generation;
  snapshot: WatchTargetSnapshot | null;
  debounceCancel: (() => void) | undefined;
  pending: PendingRun | undefined;
  active: ActiveRun | undefined;
  rescanInFlight: boolean;
  /** A hint received while a stability scan was already in flight. */
  deferredTrigger: Exclude<WatchTrigger, "initial"> | undefined;
}

/** Bounded cancellation reason accepted by structured watch events. */
const MAX_REASON_LENGTH = 256;

/**
 * Mediates an arbitrary set of logical targets with one active child each and
 * a globally bounded number of active children. `start()` schedules generation
 * zero; only subsequent confirmed changes advance a target generation.
 */
export class WatchMediator {
  private readonly states = new Map<string, TargetState>();
  private readonly queue: TargetState[] = [];
  private readonly debounceMs: number;
  private readonly slots: number;
  private activeSlots = 0;
  private observing = false;
  private draining: Promise<void> | undefined;
  private resolveDrain: (() => void) | undefined;

  public constructor(
    targets: readonly WatchTarget[],
    private readonly dependencies: WatchMediatorDependencies,
  ) {
    this.debounceMs = dependencies.debounceMs ?? 150;
    this.slots = dependencies.slots ?? 2;
    if (!Number.isSafeInteger(this.debounceMs) || this.debounceMs < 0)
      throw new RangeError(
        "watch debounce must be a non-negative safe integer",
      );
    if (!Number.isSafeInteger(this.slots) || this.slots < 1)
      throw new RangeError("watch slots must be a positive safe integer");
    for (const target of targets) {
      if (this.states.has(target.id))
        throw new Error(`duplicate watch target: ${target.id}`);
      this.states.set(target.id, {
        target,
        generation: initialGeneration(),
        snapshot: null,
        debounceCancel: undefined,
        pending: undefined,
        active: undefined,
        rescanInFlight: false,
        deferredTrigger: undefined,
      });
    }
  }

  /** Start observing and queue every initial configured target at generation 0. */
  public async start(): Promise<void> {
    if (this.observing) return;
    this.observing = true;
    await Promise.all(
      [...this.states.values()].map(async (state) => {
        const snapshot = await this.dependencies.snapshots.scan(state.target);
        if (!this.observing) return;
        state.snapshot = snapshot;
        this.replacePending(state, {
          generation: state.generation,
          trigger: "initial",
          snapshot,
          runId: this.dependencies.createRunId(),
        });
      }),
    );
    this.pump();
  }

  /**
   * Accept a non-authoritative observer fact. Each target owns one debounce
   * timer, so a burst of rename/write events creates one rescan request.
   */
  public hint(
    targetId: string,
    trigger: Exclude<WatchTrigger, "initial"> = "change",
  ): void {
    if (!this.observing) return;
    const state = this.states.get(targetId);
    if (state === undefined) return;
    state.debounceCancel?.();
    state.debounceCancel = this.dependencies.timer.after(
      this.debounceMs,
      () => {
        state.debounceCancel = undefined;
        void this.confirmChange(state, trigger);
      },
    );
  }

  /** Force a rescan of every target after observer overflow, reset, or error. */
  public hintAll(trigger: Exclude<WatchTrigger, "initial" | "change">): void {
    if (!this.observing) return;
    for (const state of this.states.values())
      this.hint(state.target.id, trigger);
  }

  /** Stop accepting hints, cancel/reap every child, and resolve once drained. */
  public async drain(): Promise<void> {
    if (this.draining !== undefined) return this.draining;
    this.observing = false;
    for (const state of this.states.values()) {
      state.debounceCancel?.();
      state.debounceCancel = undefined;
      if (state.pending !== undefined) {
        this.emitCancel(state, state.pending, "draining");
        state.pending = undefined;
      }
      if (state.active !== undefined) {
        state.active.cancellation.cancel();
        this.emitCancel(state, state.active, "draining");
      }
    }
    this.removeQueued();
    this.draining = new Promise<void>((resolve) => {
      this.resolveDrain = resolve;
      this.finishDrainIfIdle();
    });
    return this.draining;
  }

  /** Return immutable state sufficient for non-critical application summaries. */
  public get isObserving(): boolean {
    return this.observing;
  }

  private async confirmChange(
    state: TargetState,
    trigger: Exclude<WatchTrigger, "initial">,
  ): Promise<void> {
    if (!this.observing) return;
    if (state.rescanInFlight) {
      // Do not lose an atomic-save event that arrives during the stability
      // delay. It already completed its own debounce timer, so scan it next.
      state.deferredTrigger = trigger;
      return;
    }
    state.rescanInFlight = true;
    try {
      const scanned = await this.dependencies.snapshots.scan(state.target);
      const stable = await this.dependencies.snapshots.stable(
        state.target,
        scanned,
      );
      if (!this.observing || stable === null) {
        // A partial write gets another debounce interval before it can become a
        // generation. No unstable contents can be scheduled or committed.
        if (this.observing && stable === null)
          this.hint(state.target.id, trigger);
        return;
      }
      if (state.snapshot !== null && sameSnapshot(state.snapshot, stable))
        return;
      state.snapshot = stable;
      state.generation = nextGeneration(state.generation);
      const pending: PendingRun = {
        generation: state.generation,
        trigger,
        snapshot: stable,
        runId: this.dependencies.createRunId(),
      };
      if (state.pending !== undefined)
        this.emitCancel(state, state.pending, "superseded");
      state.pending = pending;
      if (state.active !== undefined) {
        state.active.cancellation.cancel();
        this.emitCancel(state, state.active, "superseded");
      }
      this.enqueue(state);
      this.emitChange(state, pending);
      this.pump();
    } finally {
      state.rescanInFlight = false;
      const deferred = state.deferredTrigger;
      state.deferredTrigger = undefined;
      this.finishDrainIfIdle();
      if (this.observing && deferred !== undefined)
        void this.confirmChange(state, deferred);
    }
  }

  private replacePending(state: TargetState, pending: PendingRun): void {
    if (!this.observing) return;
    if (state.pending !== undefined)
      this.emitCancel(state, state.pending, "superseded");
    state.pending = pending;
    this.enqueue(state);
    this.emitChange(state, pending);
  }

  private enqueue(state: TargetState): void {
    if (!this.queue.includes(state)) this.queue.push(state);
  }

  private pump(): void {
    while (
      this.observing &&
      this.activeSlots < this.slots &&
      this.queue.length > 0
    ) {
      // Keep a replacement queued behind its still-reaping predecessor. Looking
      // for the next eligible target avoids discarding it (and still lets an
      // unrelated target use an available global slot).
      const index = this.queue.findIndex(
        (candidate) =>
          candidate.active === undefined && candidate.pending !== undefined,
      );
      if (index < 0) return;
      const state = this.queue.splice(index, 1)[0];
      if (state === undefined || state.pending === undefined) continue;
      const pending = state.pending;
      state.pending = undefined;
      const active: ActiveRun = {
        ...pending,
        cancellation: new LocalCancellation(),
      };
      state.active = active;
      this.activeSlots += 1;
      void this.execute(state, active);
    }
  }

  private async execute(state: TargetState, active: ActiveRun): Promise<void> {
    try {
      const result = await this.dependencies.run({
        target: state.target,
        generation: active.generation,
        trigger: active.trigger,
        snapshot: active.snapshot,
        runId: active.runId,
        cancellation: active.cancellation,
      });
      const fresh =
        this.observing &&
        state.generation === active.generation &&
        !active.cancellation.isCancellationRequested &&
        (await this.isSnapshotCurrent(state, active.snapshot));
      if (fresh) {
        await result.commit();
      } else {
        const reason = active.cancellation.isCancellationRequested
          ? "canceled"
          : this.observing
            ? "stale_input_or_generation"
            : "draining";
        this.emitCancel(state, active, reason);
      }
    } catch (error) {
      this.emitCancel(state, active, boundReason(error));
    } finally {
      if (state.active === active) state.active = undefined;
      this.activeSlots -= 1;
      this.finishDrainIfIdle();
      this.pump();
    }
  }

  private async isSnapshotCurrent(
    state: TargetState,
    expected: WatchTargetSnapshot,
  ): Promise<boolean> {
    const now = await this.dependencies.snapshots.scan(state.target);
    return sameSnapshot(now, expected);
  }

  private removeQueued(): void {
    this.queue.splice(0, this.queue.length);
  }

  private finishDrainIfIdle(): void {
    if (
      this.draining !== undefined &&
      this.activeSlots === 0 &&
      ![...this.states.values()].some((state) => state.rescanInFlight)
    ) {
      this.resolveDrain?.();
      this.resolveDrain = undefined;
    }
  }

  private emitChange(state: TargetState, work: PendingRun): void {
    this.dependencies.emit?.(
      Object.freeze({
        event: "watch.change",
        target: state.target.id,
        slug: state.target.slug,
        generation: work.generation,
        trigger: work.trigger,
        runId: work.runId,
      }),
    );
  }

  private emitCancel(
    state: TargetState,
    work: Pick<PendingRun, "generation" | "trigger" | "runId">,
    reason: string,
  ): void {
    this.dependencies.emit?.(
      Object.freeze({
        event: "watch.cancel",
        target: state.target.id,
        slug: state.target.slug,
        generation: work.generation,
        trigger: work.trigger,
        runId: work.runId,
        reason: boundReason(reason),
      }),
    );
  }
}

/** Private mutable source exposed only as the read-only execution token. */
class LocalCancellation implements CancellationToken {
  private requested = false;
  private readonly listeners = new Set<() => void>();
  public get isCancellationRequested(): boolean {
    return this.requested;
  }
  public onCancel(listener: () => void): () => void {
    if (this.requested) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public throwIfCancellationRequested(): void {
    if (this.requested) throw new Error("watch run canceled");
  }
  public cancel(): void {
    if (this.requested) return;
    this.requested = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

function sameSnapshot(
  left: WatchTargetSnapshot,
  right: WatchTargetSnapshot,
): boolean {
  return (
    left.inputHash === right.inputHash &&
    left.configurationHash === right.configurationHash
  );
}
function boundReason(reason: unknown): string {
  const value = reason instanceof Error ? reason.message : String(reason);
  return value.slice(0, MAX_REASON_LENGTH);
}
