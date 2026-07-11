/**
 * Stable identity of the `python-uv` runtime.
 *
 * The {@link RuntimeDescriptor} advertises the runtime's id, a human-facing name,
 * and the codec versions it speaks. The codec versions are metadata that let the
 * composition root pair this runtime with a matching {@link Codec}; both the
 * input and output framing use the single `tagged-jsonl-v1` codec (task 04).
 *
 * This module is pure: it builds a value from the codec's version constant.
 */

import type { RuntimeDescriptor } from "../../ports/index.js";
import { CODEC_VERSION } from "../../../judging/codec/index.js";

/** Stable identifier of the Python-over-`uv` runtime. */
export const PYTHON_UV_RUNTIME_ID = "python-uv";

/**
 * Build the descriptor for the `python-uv` runtime.
 *
 * Both codec versions are {@link CODEC_VERSION} because the request and response
 * envelopes are framed by the same `tagged-jsonl-v1` codec.
 *
 * @returns The immutable runtime descriptor.
 */
export function pythonUvDescriptor(): RuntimeDescriptor {
  return {
    id: PYTHON_UV_RUNTIME_ID,
    displayName: "Python (uv)",
    inputCodecVersion: CODEC_VERSION,
    outputCodecVersion: CODEC_VERSION,
  };
}
