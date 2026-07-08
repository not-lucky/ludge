/**
 * Runtime adapter port.
 *
 * A {@link RuntimeAdapter} describes a language runtime (for example Python via
 * `uv`) and knows how to turn an immutable {@link ExecutionRequest} into a
 * concrete {@link ArgvInvocation}. It is the Adapter/Factory-Method seam that
 * lets a new runtime be added by implementing this interface and registering it
 * at the composition root — application and policy layers do not change.
 *
 * This module is pure: it declares contracts only and imports no runtime,
 * adapter, or Node module (only domain value types and sibling ports).
 */

import type { ExecutionRequest } from "../../domain/index.js";
import type { ArgvInvocation } from "./invocation.js";

/**
 * Stable, human- and machine-readable identity of a runtime.
 *
 * The codec versions declare which value framing the runtime speaks so that the
 * composition root can pair it with a matching {@link Codec}; they are metadata,
 * not an instruction to import anything.
 */
export interface RuntimeDescriptor {
  /** Stable runtime identifier (e.g. `"python-uv"`). */
  readonly id: string;
  /** Human-facing runtime name for reporting. */
  readonly displayName: string;
  /** Version of the input codec this runtime expects. */
  readonly inputCodecVersion: string;
  /** Version of the output codec this runtime emits. */
  readonly outputCodecVersion: string;
}

/**
 * Translates execution requests into concrete process invocations for one
 * language runtime.
 *
 * The `Tag` brand ties the adapter to the {@link RuntimeBundle} that produced
 * it: because `backendId` is a used member, a `RuntimeAdapter<"a">` cannot be
 * placed where a `RuntimeAdapter<"b">` is expected, preventing an incompatible
 * launcher + codec pairing at the type level.
 *
 * @typeParam Tag - The owning backend's coherence tag.
 */
export interface RuntimeAdapter<Tag extends string = string> {
  /** The backend this adapter belongs to; enforces bundle coherence. */
  readonly backendId: Tag;
  /**
   * Describe this runtime's stable identity and codec versions.
   *
   * @returns The runtime descriptor.
   */
  describe(): RuntimeDescriptor;
  /**
   * Build the argv invocation that launches the target for `request`.
   *
   * The adapter only names the invocation; it never reads or evaluates the
   * target script itself.
   *
   * @param request - The immutable execution request.
   * @returns A direct, non-shell {@link ArgvInvocation}.
   */
  buildInvocation(request: ExecutionRequest): ArgvInvocation;
}
