/**
 * Configuration fixtures for the test suite.
 *
 * The configuration and black-box testing spec calls for a fixed roster of
 * fixture modes — default, strict Linux, unsafe degraded, low memory, low time,
 * output capped, and benchmark. Each mode pairs a `problem.yaml` on disk with
 * the environment, CLI, and required-control knobs that characterize it, so
 * precedence, validator, and (later, task 17) black-box tests can drive a
 * realistic effective configuration without re-deriving it inline.
 *
 * This is scaffolding: it enumerates the modes and resolves their roots; the
 * full black-box harness that consumes them lands in task 17.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  CliOverrides,
  EnvironmentRecord,
} from "../../../src/infrastructure/config/index.js";
import type { ControlId } from "../../../src/execution/sandbox/linux/controls/ids.js";

/** Directory containing this module (`tests/fixtures/config`). */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The stable set of configuration fixture mode names. */
export type ConfigFixtureName =
  | "default"
  | "strict-linux"
  | "unsafe-degraded"
  | "low-memory"
  | "low-time"
  | "output-capped"
  | "benchmark";

/** A single configuration fixture: a problem root plus its resolution knobs. */
export interface ConfigFixture {
  /** The mode name. */
  readonly name: ConfigFixtureName;
  /** Absolute path to the fixture's problem root (holds `problem.yaml`). */
  readonly problemRoot: string;
  /** Absolute path to the fixture's `problem.yaml`. */
  readonly problemYaml: string;
  /** `PALESTRA_*` environment overrides that define this mode. */
  readonly env: EnvironmentRecord;
  /** CLI-flag overrides that define this mode. */
  readonly cli: CliOverrides;
  /** Sandbox controls this mode requires (empty when enforcement is bypassed). */
  readonly requiredControls: readonly ControlId[];
  /** A one-line description of what the mode exercises. */
  readonly description: string;
}

/** Build a fixture descriptor rooted at `tests/fixtures/config/<name>`. */
function fixture(
  name: ConfigFixtureName,
  overrides: {
    readonly env?: EnvironmentRecord;
    readonly cli?: CliOverrides;
    readonly requiredControls?: readonly ControlId[];
    readonly description: string;
  },
): ConfigFixture {
  const problemRoot = join(HERE, name);
  return {
    name,
    problemRoot,
    problemYaml: join(problemRoot, "problem.yaml"),
    env: overrides.env ?? {},
    cli: overrides.cli ?? {},
    requiredControls: overrides.requiredControls ?? ["cgroup"],
    description: overrides.description,
  };
}

/** The full set of controls a strict Linux host is expected to install. */
const STRICT_CONTROLS: readonly ControlId[] = [
  "cgroup",
  "rlimits",
  "network",
  "filesystem",
  "no-new-privileges",
  "drop-capabilities",
  "namespaces",
];

/** Every configuration fixture, keyed by mode name. */
export const CONFIG_FIXTURES: Readonly<
  Record<ConfigFixtureName, ConfigFixture>
> = {
  default: fixture("default", {
    description: "baseline problem with built-in default limits",
  }),
  "strict-linux": fixture("strict-linux", {
    requiredControls: STRICT_CONTROLS,
    description: "full-enforcement Linux requiring every sandbox control",
  }),
  "unsafe-degraded": fixture("unsafe-degraded", {
    cli: { unsafeLocal: true },
    requiredControls: [],
    description: "explicit --unsafe-local; results labeled sandbox_unsupported",
  }),
  "low-memory": fixture("low-memory", {
    description: "reduced memory ceiling to exercise mle classification",
  }),
  "low-time": fixture("low-time", {
    description: "reduced wall/cpu deadlines to exercise tle classification",
  }),
  "output-capped": fixture("output-capped", {
    description: "small output ceilings to exercise output_limit classification",
  }),
  benchmark: fixture("benchmark", {
    description: "generous limits with generator/naive for benchmark runs",
  }),
};
