/** Shared external-boundary preparation for commands that execute a problem. */

import { realpath } from "node:fs/promises";
import { createPythonLinuxRunner } from "../execution/python-linux-runner.js";
import type { Runner } from "../execution/runner.js";
import {
  loadRunContext,
  type LoadRunContextOptions,
  type RunContext,
} from "../infrastructure/problem.js";

export interface PreparedRunContext {
  readonly context: RunContext;
  readonly runner: Runner;
}

export interface PrepareRunOptions extends Omit<
  LoadRunContextOptions,
  "realpath"
> {
  readonly benchmarkCpuWeight?: number;
}

/** Load/validate a problem once and construct the only available runner. */
export async function prepareRunContext(
  options: PrepareRunOptions,
): Promise<PreparedRunContext> {
  const { benchmarkCpuWeight, ...loadOptions } = options;
  const context = await loadRunContext({ ...loadOptions, realpath });
  return {
    context,
    runner: createPythonLinuxRunner(context, benchmarkCpuWeight),
  };
}
