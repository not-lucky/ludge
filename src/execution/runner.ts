/** The only execution stack supported by this build: Python through uv on Linux. */

import type {
  ExecutionRequest,
  RawProcessResult,
} from "../domain/execution.js";
import type { ExecutionProfile } from "../telemetry/profile.js";
import type { CancellationToken } from "./cancellation.js";

export interface ArgvInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface Runner {
  run(
    request: ExecutionRequest,
    input: Uint8Array,
    cancellation: CancellationToken,
  ): Promise<RawProcessResult>;
  beginProfile(): { finish(raw: RawProcessResult): ExecutionProfile };
}
