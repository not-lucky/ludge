/** Shared one-request isolated execution primitive for fuzzing and replay. */

import { createHash } from "node:crypto";
import type { CanonicalValue } from "../judging/value/index.js";
import type { ExecutionRequest, RawProcessResult, ResourceLimits, TerminationCause } from "../domain/index.js";
import type { CancellationToken, RuntimeBundle } from "../execution/ports/index.js";
import { decodeResponseLine, encodeRequestLine } from "../judging/codec/index.js";
import { canonicalStringOf } from "../judging/codec/encode.js";
import type { EffectiveConfig } from "../infrastructure/config/index.js";
import type { FuzzExecutionEnvelope } from "./fuzz-artifact.js";

/** One implementation run, preserving raw facts without rewriting its status. */
export interface IsolatedExecution {
  readonly status: TerminationCause;
  readonly requestBytes: Uint8Array;
  readonly raw: RawProcessResult;
  readonly output: CanonicalValue | null;
  readonly exception: CanonicalValue | null;
  readonly envelope: FuzzExecutionEnvelope;
}

/** Dependencies selected by the composition root. */
export interface IsolatedExecutionDependencies {
  readonly bundle: RuntimeBundle;
  readonly cancellation: CancellationToken;
  readonly classifyTermination: (raw: RawProcessResult, limits: ResourceLimits) => TerminationCause;
}

/** Build a single request from canonical input and run its selected role once. */
export async function executeIsolated(
  effective: EffectiveConfig,
  request: Omit<ExecutionRequest, "inputBytes">,
  input: CanonicalValue,
  dependencies: IsolatedExecutionDependencies,
): Promise<IsolatedExecution> {
  const requestBytes = encodeRequestLine({
    protocolVersion: 1,
    kind: "request",
    runId: request.runId,
    caseId: request.caseId,
    codecVersion: request.inputCodecVersion,
    messageLimitBytes: request.limits.inputBytes,
    input,
  });
  return executeEncodedIsolated(effective, { ...request, inputBytes: requestBytes }, dependencies);
}

/** Execute an already-encoded request byte-for-byte, used for naive/solution parity. */
export async function executeEncodedIsolated(
  effective: EffectiveConfig,
  request: ExecutionRequest,
  dependencies: IsolatedExecutionDependencies,
): Promise<IsolatedExecution> {
  if (request.inputBytes.length > request.limits.inputBytes) throw new Error("encoded request exceeds configured input limit");
  const raw = await dependencies.bundle.sandbox.run(
    dependencies.bundle.runtime.buildInvocation(request), request.inputBytes, request.limits, dependencies.cancellation,
  );
  let status = dependencies.classifyTermination(raw, request.limits);
  let output: CanonicalValue | null = null;
  let exception: CanonicalValue | null = null;
  if (status === "passed") {
    const decoded = decodeResponseLine(raw.stdout.data, { runId: request.runId, caseId: request.caseId, codecVersion: effective.problem.outputCodec });
    if (!decoded.ok) status = "protocol_error";
    else if (decoded.envelope.exception !== null) exception = decoded.envelope.exception;
    else if (decoded.envelope.output !== null) output = decoded.envelope.output;
    else status = "protocol_error";
  }
  const envelope: FuzzExecutionEnvelope = Object.freeze({
    status,
    exitCode: raw.exitCode,
    signal: raw.signal,
    stdoutBase64Url: Buffer.from(raw.stdout.data).toString("base64url"),
    stderrBase64Url: Buffer.from(raw.stderr.data).toString("base64url"),
    stdoutTruncated: raw.stdout.truncated,
    stderrTruncated: raw.stderr.truncated,
    stdoutBytes: raw.stdout.totalBytes,
    stderrBytes: raw.stderr.totalBytes,
    wallTimeMs: raw.resources.wallTimeMs,
    cpuTimeMs: raw.resources.cpuTimeMs,
    memoryPeakBytes: raw.resources.memoryPeakBytes,
    termination: raw.termination,
    exception: exception === null ? null : JSON.parse(canonicalJson(exception)),
    output: output === null ? null : JSON.parse(canonicalJson(output)),
  });
  return Object.freeze({ status, requestBytes: request.inputBytes, raw, output, exception, envelope });
}

/** Stable input hash suitable for persisted run/case fields. */
export function sha256Bytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function canonicalJson(value: CanonicalValue): string {
  return canonicalStringOf(value);
}
