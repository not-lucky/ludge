/** Shared canonical request → isolated process → response classification boundary. */

import { createHash } from "node:crypto";
import type {
  ExecutionRequest,
  RawProcessResult,
} from "../domain/execution.js";
import type { ResourceLimits } from "../domain/limits.js";
import type { TerminationCause } from "../domain/status.js";
import type { CancellationToken } from "../execution/cancellation.js";
import type { Runner } from "../execution/runner.js";
import type { RunContext } from "../infrastructure/problem.js";
import {
  decodeResponseLine,
  encodeRequestLine,
} from "../judging/codec/envelope.js";
import { canonicalStringOf } from "../judging/codec/encode.js";
import { isLeetCodeValue } from "../judging/leetcode.js";
import type { CanonicalValue } from "../judging/value/model.js";
import type { FuzzExecutionEnvelope } from "./fuzz-artifact.js";

export interface ExecutedCase {
  readonly status: TerminationCause;
  readonly requestBytes: Uint8Array;
  readonly raw: RawProcessResult;
  readonly output: CanonicalValue | null;
  readonly exception: CanonicalValue | null;
  readonly envelope: FuzzExecutionEnvelope;
}

export type IsolatedExecution = ExecutedCase;

export interface ExecuteCaseDependencies {
  readonly runner: Runner;
  readonly cancellation: CancellationToken;
  readonly classifyTermination: (
    raw: RawProcessResult,
    limits: ResourceLimits,
  ) => TerminationCause;
}

export async function executeCase(
  context: Pick<RunContext, "problem">,
  request: Omit<ExecutionRequest, "inputBytes">,
  input: CanonicalValue,
  dependencies: ExecuteCaseDependencies,
): Promise<ExecutedCase> {
  const requestBytes = encodeRequestLine({
    protocolVersion: 1,
    kind: "request",
    runId: request.runId,
    caseId: request.caseId,
    codecVersion: request.inputCodecVersion,
    messageLimitBytes: request.limits.inputBytes,
    input,
  });
  return executeEncodedCase(
    context,
    { ...request, inputBytes: requestBytes },
    dependencies,
  );
}

export async function executeEncodedCase(
  context: Pick<RunContext, "problem">,
  request: ExecutionRequest,
  dependencies: ExecuteCaseDependencies,
): Promise<ExecutedCase> {
  if (request.inputBytes.length > request.limits.inputBytes) {
    throw new Error("encoded request exceeds configured input limit");
  }
  const raw = await dependencies.runner.run(
    request,
    request.inputBytes,
    dependencies.cancellation,
  );
  let status = dependencies.classifyTermination(raw, request.limits);
  let output: CanonicalValue | null = null;
  let exception: CanonicalValue | null = null;
  if (status === "passed") {
    const decoded = decodeResponseLine(raw.stdout.data, {
      runId: request.runId,
      caseId: request.caseId,
      codecVersion: context.problem.outputCodec,
    });
    if (!decoded.ok) status = "protocol_error";
    else if (decoded.envelope.exception !== null)
      exception = decoded.envelope.exception;
    else if (decoded.envelope.output !== null) {
      if (isLeetCodeValue(decoded.envelope.output))
        output = decoded.envelope.output;
      else status = "protocol_error";
    } else status = "protocol_error";
  }
  const envelope: FuzzExecutionEnvelope = {
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
    exception:
      exception === null ? null : JSON.parse(canonicalStringOf(exception)),
    output: output === null ? null : JSON.parse(canonicalStringOf(output)),
  };
  return {
    status,
    requestBytes: request.inputBytes,
    raw,
    output,
    exception,
    envelope,
  };
}

export const sha256Bytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
