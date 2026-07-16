#!/usr/bin/env node
/**
 * Executable bootstrap for the Palestra CLI.
 *
 * This file intentionally contains no command grammar or business logic. It
 * installs process-signal observation before dispatch, composes the process
 * context, then parses, dispatches, renders, and closes exactly once. Every
 * normal failure crosses the boundary as a structured outcome; target signals
 * are handler data (`signaled`), never Node process crashes.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ProblemError } from "../infrastructure/problem.js";
import { maybeCgroupReexec } from "./cgroup-reexec.js";
import {
  dispatchCommand,
  parseCommand,
  type Command,
  type ParseDependencies,
} from "./command.js";
import {
  createAppContext,
  releaseAppContext,
  type AppContext,
  type AppContextDependencies,
} from "./context.js";
import { normalizeCliError } from "./error.js";
import {
  internalErrorOutcome,
  invalidInputOutcome,
  labelUnsafeLocalOutcome,
  outcome,
  type CliOutcome,
} from "./outcome.js";
import { processWriters, renderOutcome, type CliWriters } from "./output.js";
import type { RemoveSignalListener, ShutdownSignal } from "./shutdown.js";

/** Injectable signal listener registration used by the asynchronous bootstrap. */
export type BootstrapSignalRegistrar = (
  signal: ShutdownSignal,
  listener: () => void,
) => RemoveSignalListener;

/** Dependencies for deterministic bootstrap tests and alternate embeddings. */
export interface BootstrapDependencies {
  /** Build the process resource owner. */
  readonly createContext?: (
    dependencies?: AppContextDependencies,
  ) => AppContext;
  /** Context constructor dependencies, used only by the default factory. */
  readonly contextDependencies?: AppContextDependencies;
  /** Output writers; defaults to Node stdout/stderr. */
  readonly writers?: CliWriters;
  /** Signal registration seam; defaults to `process.on` / `process.off`. */
  readonly registerSignal?: BootstrapSignalRegistrar;
  /** Parser seams, primarily deterministic correlation IDs in tests. */
  readonly parser?: ParseDependencies;
}

/**
 * Run one CLI invocation and return its contract exit code.
 *
 * A received SIGINT/SIGTERM always wins while parsing or dispatch is still in
 * progress. The signal path first makes the shutdown coordinator reject new
 * work and cancel active work, then this function renders one `canceled`
 * outcome after cleanup has drained. It deliberately does not call
 * `process.exit`: assigning the returned code in the executable wrapper lets
 * Node flush the one JSON envelope and close resources safely.
 */
export async function bootstrap(
  argv: readonly string[],
  dependencies: BootstrapDependencies = {},
): Promise<number> {
  const writers = dependencies.writers ?? processWriters;
  const registerSignal = dependencies.registerSignal ?? registerNodeSignal;
  const jsonRequested = argv.includes("--json");
  let context: AppContext | undefined;
  let signalReceived = false;
  let signalDrain: Promise<void> | undefined;
  const removers: RemoveSignalListener[] = [];
  let rendered = false;

  const renderOnce = (
    mode: "human" | "json",
    command: Command | null,
    commandOutcome: CliOutcome,
  ): number => {
    if (!rendered) {
      renderOutcome(writers, mode, command, commandOutcome);
      rendered = true;
    }
    return commandOutcome.exitCode;
  };

  try {
    context = (dependencies.createContext ?? createAppContext)(
      dependencies.contextDependencies,
    );
    const onSignal = (): void => {
      signalReceived = true;
      // `shutdown()` is one-way and idempotent, so simultaneous SIGINT and
      // SIGTERM listeners share cancellation, active-work draining, and cleanup.
      signalDrain ??= context?.shutdown.shutdown() ?? Promise.resolve();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      removers.push(registerSignal(signal, onSignal));
    }

    const parsed = parseCommand(argv, dependencies.parser);
    const mode = parsed.ok
      ? outputModeForCommand(parsed.command)
      : parsed.json
        ? "json"
        : "human";

    if (signalReceived) {
      await signalDrain;
      return renderOnce(
        mode,
        parsed.ok ? parsed.command : null,
        cancellationOutcome(),
      );
    }
    if (!parsed.ok) {
      return renderOnce(mode, null, parsed.outcome);
    }

    const work = context.shutdown.beginWork();
    if (work === undefined) {
      await (signalDrain ?? context.shutdown.shutdown());
      return renderOnce(mode, parsed.command, cancellationOutcome());
    }

    let handled: CliOutcome;
    try {
      handled = await dispatchCommand(parsed.command, context.handlers);
    } catch (error) {
      handled = errorOutcome(error);
    } finally {
      work.complete();
    }

    if (signalReceived) {
      await signalDrain;
      return renderOnce(mode, parsed.command, cancellationOutcome());
    }
    return renderOnce(
      mode,
      parsed.command,
      labelUnsafeLocalOutcome(
        "unsafeLocal" in parsed.command.options &&
          parsed.command.options.unsafeLocal,
        handled,
      ),
    );
  } catch (error) {
    const command = null;
    return renderOnce(
      jsonRequested ? "json" : "human",
      command,
      errorOutcome(error),
    );
  } finally {
    for (const remove of removers) {
      remove();
    }
    // Signal shutdown owns normal cleanup ordering. Direct close is an
    // idempotent fallback for parse failures and ordinary completed commands.
    await context?.close();
    if (
      context !== undefined &&
      dependencies.createContext === undefined &&
      dependencies.contextDependencies === undefined
    ) {
      releaseAppContext(context);
    }
  }
}

/** A cancellation result emitted when a user signal beats command completion. */
function cancellationOutcome(): CliOutcome {
  return outcome("canceled", null, [
    { code: "canceled", message: "operation canceled by user signal" },
  ]);
}

/** Translate known CLI input faults and unexpected bootstrap faults structurally. */
function errorOutcome(error: unknown): CliOutcome {
  // Configuration/path/schema errors are invalid user/problem data by contract,
  // even when a future application facade lets one escape rather than returning
  // its own outcome.
  if (error instanceof ProblemError) {
    return invalidInputOutcome(error.message, "configuration_error");
  }
  const normalized = normalizeCliError(error);
  return normalized.kind === "invalid_input"
    ? invalidInputOutcome(normalized.message, normalized.code)
    : internalErrorOutcome(normalized.message, normalized.code);
}

/** Determine whether a command requested the JSON envelope mode. */
function outputModeForCommand(command: Command): "human" | "json" {
  return "json" in command.options && command.options.json ? "json" : "human";
}

function registerNodeSignal(
  signal: ShutdownSignal,
  listener: () => void,
): RemoveSignalListener {
  process.on(signal, listener);
  return () => process.off(signal, listener);
}

/** Execute only when Node invoked this module as the package binary. */
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  // On Linux, check whether the current process lives in the same cgroup
  // subtree as PALESTRA_CGROUP_PARENT.  If not, transparently re-exec
  // under `systemd-run` in the correct slice so that child-PID migration
  // into the sandbox cgroup is permitted by the kernel.  This must run
  // before any async bootstrap work to avoid partially constructed state.
  const reexecCode = maybeCgroupReexec(process.argv.slice(2));
  if (reexecCode !== undefined) {
    process.exitCode = reexecCode;
  } else {
    void bootstrap(process.argv.slice(2)).then((exitCode) => {
      process.exitCode = exitCode;
    });
  }
}
