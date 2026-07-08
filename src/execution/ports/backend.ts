/**
 * ExecutionBackend abstract factory.
 *
 * An {@link ExecutionBackend} is the Abstract Factory that produces one
 * coherent {@link RuntimeBundle}: a runtime launcher, matching input/output
 * codecs, a sandbox, and a profiler that are guaranteed to belong together. A
 * new backend implements this interface and registers exactly ONE bundle at the
 * composition root (task 11); the rest of the system depends only on the
 * bundle, never on how it was assembled.
 *
 * Coherence is enforced at the type level by a shared string `Tag`. Every
 * backend-specific component carries a `readonly backendId: Tag`, so a
 * component branded `"a"` is not assignable where a `"b"` component is expected.
 * A {@link RuntimeBundle} therefore cannot be assembled from a launcher of one
 * backend and a codec of another — the classic "incompatible codec + launcher"
 * mistake becomes a compile error.
 *
 * This module is pure: it declares contracts only and imports no runtime,
 * adapter, or Node module (only sibling ports).
 */

import type { Codec } from "../../judging/ports/index.js";
import type { Profiler } from "./profiler.js";
import type { RuntimeAdapter, RuntimeDescriptor } from "./runtime.js";
import type { Sandbox } from "./sandbox.js";

/** Stable identity of an execution backend, used for selection and reporting. */
export interface BackendDescriptor {
  /** Stable backend identifier (e.g. `"python-uv-linux"`). */
  readonly id: string;
  /** Human-facing backend name for reporting. */
  readonly displayName: string;
  /** The runtime the backend launches. */
  readonly runtime: RuntimeDescriptor;
}

/**
 * A coherent set of runtime components produced together by one backend.
 *
 * All members share the same `Tag`, so the bundle is internally consistent by
 * construction. `TValue` is the canonical value model (task 04) both codecs
 * frame; `TProfile` is the profiling record (task 10) the profiler emits.
 *
 * @typeParam Tag - The backend coherence tag shared by every member.
 * @typeParam TValue - The canonical value model the codecs frame.
 * @typeParam TProfile - The profiling record the profiler emits.
 */
export interface RuntimeBundle<
  Tag extends string = string,
  TValue = unknown,
  TProfile = unknown,
> {
  /** The backend tag shared by every member of this bundle. */
  readonly backendId: Tag;
  /** The runtime launcher. */
  readonly runtime: RuntimeAdapter<Tag>;
  /** Codec used to frame request input. */
  readonly inputCodec: Codec<TValue, Tag>;
  /** Codec used to parse response output. */
  readonly outputCodec: Codec<TValue, Tag>;
  /** The sandbox that supervises target execution. */
  readonly sandbox: Sandbox<Tag>;
  /** The profiler that measures each execution. */
  readonly profiler: Profiler<TProfile, Tag>;
}

/**
 * Abstract factory that describes a backend and creates its coherent bundle.
 *
 * @typeParam Tag - The backend coherence tag.
 * @typeParam TValue - The canonical value model the codecs frame.
 * @typeParam TProfile - The profiling record the profiler emits.
 */
export interface ExecutionBackend<
  Tag extends string = string,
  TValue = unknown,
  TProfile = unknown,
> {
  /**
   * Describe this backend's stable identity.
   *
   * @returns The backend descriptor.
   */
  describe(): BackendDescriptor;
  /**
   * Create a fresh, coherent runtime bundle.
   *
   * @returns A {@link RuntimeBundle} whose members all share this backend's tag.
   */
  create(): RuntimeBundle<Tag, TValue, TProfile>;
}
