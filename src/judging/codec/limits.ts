/**
 * Codec resource limits and budget accounting.
 *
 * The `tagged-jsonl-v1` codec enforces three hard bounds before any application
 * code sees a value, per `docs/contracts/value-model-and-protocol.md`:
 * nesting depth, total node count, and encoded payload size. Exceeding any of
 * them is a protocol error.
 *
 * This module is pure: constants plus a small mutable {@link Budget} helper that
 * threads depth/node accounting through a single decode or encode traversal.
 */

/** Maximum nesting depth of a canonical value (inclusive). */
export const MAX_DEPTH = 256;

/** Maximum number of value nodes in a single canonical value. */
export const MAX_NODES = 1_000_000;

/** Maximum size, in bytes, of an encoded canonical payload (16 MiB). */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Raised when a codec traversal exceeds a configured limit.
 *
 * It is thrown internally by {@link Budget} and translated by the codec into a
 * decode failure result (or an encode throw); it never escapes to callers as a
 * raw error type they must catch.
 */
export class LimitExceededError extends Error {
  public constructor(
    /** Which bound was exceeded. */
    public readonly limit: "depth" | "nodes" | "payload",
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * A mutable accountant for a single codec traversal.
 *
 * A fresh {@link Budget} is created per encode/decode call. {@link enter} is
 * called when descending into a node and {@link leave} when ascending, so depth
 * is tracked precisely; {@link countNode} tallies the total node count. Both
 * throw {@link LimitExceededError} the moment a bound is crossed, so an
 * adversarial payload is rejected early rather than after full materialization.
 */
export class Budget {
  private depth = 0;
  private nodes = 0;

  /**
   * @param maxDepth - Maximum nesting depth; defaults to {@link MAX_DEPTH}.
   * @param maxNodes - Maximum node count; defaults to {@link MAX_NODES}.
   */
  public constructor(
    private readonly maxDepth: number = MAX_DEPTH,
    private readonly maxNodes: number = MAX_NODES,
  ) {}

  /** Tally one value node, throwing if the node budget is exhausted. */
  public countNode(): void {
    this.nodes += 1;
    if (this.nodes > this.maxNodes) {
      throw new LimitExceededError(
        "nodes",
        `node count exceeds limit of ${this.maxNodes}`,
      );
    }
  }

  /** Descend one level, throwing if the depth budget is exceeded. */
  public enter(): void {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      throw new LimitExceededError(
        "depth",
        `nesting depth exceeds limit of ${this.maxDepth}`,
      );
    }
  }

  /** Ascend one level. */
  public leave(): void {
    this.depth -= 1;
  }
}
