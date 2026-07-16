/**
 * Bounded output collector (Decorator over a byte stream).
 *
 * A target's stdout/stderr must be captured up to a fixed byte ceiling and no
 * further, yet the pipe MUST keep draining after the ceiling is reached — a
 * blocked pipe would wedge the child and defeat the wall-clock deadline. This
 * collector solves both: it retains at most `capBytes` and discards the rest,
 * while still counting every byte it sees so the {@link BoundedOutput}'s
 * `totalBytes`/`truncated` reflect the full stream.
 *
 * It is a pure in-memory accumulator: the caller feeds it chunks read from a
 * Node pipe (the collector itself performs no I/O), so it is trivially unit
 * testable without spawning a process.
 */

import type { BoundedOutput } from "../domain/index.js";

/**
 * Accumulates a single output stream up to a byte cap.
 *
 * Bytes past `capBytes` are counted but not stored, so memory stays bounded by
 * the cap regardless of how much the target emits.
 */
export class BoundedCollector {
  private readonly chunks: Uint8Array[] = [];
  private storedBytes = 0;
  private totalBytesSeen = 0;

  /**
   * @param capBytes - Maximum number of bytes to retain; must be non-negative.
   */
  public constructor(private readonly capBytes: number) {}

  /**
   * Feed a chunk read from the stream.
   *
   * Every byte counts toward {@link totalBytes}; only the prefix that still fits
   * under the cap is retained. Draining continues normally once the cap is hit.
   *
   * @param chunk - The bytes read from the underlying pipe.
   */
  public push(chunk: Uint8Array): void {
    this.totalBytesSeen += chunk.byteLength;
    const remaining = this.capBytes - this.storedBytes;
    if (remaining <= 0) {
      return;
    }
    if (chunk.byteLength <= remaining) {
      this.chunks.push(chunk);
      this.storedBytes += chunk.byteLength;
      return;
    }
    // Retain only the portion that fits; the tail is dropped but still counted.
    this.chunks.push(chunk.subarray(0, remaining));
    this.storedBytes += remaining;
  }

  /** Total bytes observed across all chunks, including any dropped past the cap. */
  public get totalBytes(): number {
    return this.totalBytesSeen;
  }

  /** Whether more bytes were seen than the cap allowed to be retained. */
  public get truncated(): boolean {
    return this.totalBytesSeen > this.storedBytes;
  }

  /**
   * Materialize the retained bytes into a single contiguous buffer.
   *
   * @returns The captured (possibly truncated) prefix of the stream.
   */
  public bytes(): Uint8Array {
    const out = new Uint8Array(this.storedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /**
   * Snapshot the collector as the immutable {@link BoundedOutput} domain value.
   *
   * @returns The bounded capture with data, truncation flag, and total length.
   */
  public toBoundedOutput(): BoundedOutput {
    return {
      data: this.bytes(),
      truncated: this.truncated,
      totalBytes: this.totalBytesSeen,
    };
  }
}
