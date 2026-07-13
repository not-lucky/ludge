/**
 * Problem-scaffolding application service.
 *
 * The command creates its directory exclusively before writing the starter
 * document, then registers the same problem through the transaction-only
 * persistence port. A failure after the exclusive create removes only that
 * newly-created directory; it never removes a directory that predated this
 * invocation.
 */

import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { isValidSlug } from "../infrastructure/config/slug.js";
import type { PersistenceRecords, TransactionScope } from "../persistence/ports/index.js";

/** JSON-safe success payload for an initialized problem. */
export interface InitCommandResult {
  readonly slug: string;
  readonly title: string;
  readonly problemDirectory: string;
  readonly problemYamlPath: string;
  readonly problemId: string;
}

/** Application diagnostic, translated by the CLI composition root. */
export interface InitDiagnostic {
  readonly code: string;
  readonly message: string;
}

/** Result before the CLI maps it to an output envelope. */
export interface InitApplicationOutcome {
  readonly status: "passed" | "invalid_input" | "internal_error";
  readonly result: InitCommandResult | null;
  readonly diagnostics: readonly InitDiagnostic[];
}

/** The only problem-row fields this use case needs to persist. */
export interface InitProblemRow {
  readonly problem_id: string;
  readonly slug: string;
  readonly schema_version: number;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Record bundle accepted by the init transaction. */
export interface InitPersistenceRecords extends PersistenceRecords {
  readonly problem: InitProblemRow;
  readonly replay: unknown;
}

/** Dependencies selected by the composition root, with deterministic test seams. */
export interface InitCommandDependencies {
  readonly invocationDirectory: string;
  readonly transaction: TransactionScope<InitPersistenceRecords>;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Strict schema-v1 starter document written by {@link executeInitCommand}. */
export function starterProblemYaml(slug: string): string {
  return [
    "schemaVersion: 1",
    `slug: ${slug}`,
    `title: ${titleForSlug(slug)}`,
    "entrypoint: solution.py",
    "runtime: python-uv",
    "inputCodec: tagged-jsonl-v1",
    "outputCodec: tagged-jsonl-v1",
    "comparisonPolicy: exact-v1",
    "limits: {}",
    "casesDir: cases",
    "",
  ].join("\n");
}

/** Create, scaffold, and durably register a new problem. */
export async function executeInitCommand(
  slug: string,
  dependencies: InitCommandDependencies,
): Promise<InitApplicationOutcome> {
  if (!isValidSlug(slug)) {
    return failure("invalid_input", "invalid_slug", `invalid slug ${JSON.stringify(slug)}`);
  }

  let created = false;
  let problemDirectory = "";
  try {
    // Resolve existing ancestors before creating the exclusive child. This
    // rejects a pre-existing `problems` symlink that leads outside the invoked
    // project rather than writing through it.
    const invocationRoot = await realpath(resolve(dependencies.invocationDirectory));
    const problemsDirectory = resolve(invocationRoot, "problems");
    await mkdir(problemsDirectory, { recursive: true });
    const actualProblemsDirectory = await realpath(problemsDirectory);
    if (!isDescendant(invocationRoot, actualProblemsDirectory)) {
      return failure("invalid_input", "invalid_path", "problems directory escapes the invocation root");
    }
    problemDirectory = resolve(actualProblemsDirectory, slug);
    if (!isDescendant(actualProblemsDirectory, problemDirectory)) {
      return failure("invalid_input", "invalid_path", "problem path escapes the problems directory");
    }
    await mkdir(problemDirectory); // exclusive: EEXIST is a user-data error
    created = true;

    const title = titleForSlug(slug);
    const yamlPath = resolve(problemDirectory, "problem.yaml");
    await writeFile(yamlPath, starterProblemYaml(slug), { encoding: "utf8", flag: "wx" });

    const timestamp = dependencies.now();
    const problemId = dependencies.createId();
    await dependencies.transaction.transact(async (uow) => {
      if (await uow.problems.findBySlug(slug) !== null) {
        throw new ExistingProblemError(slug);
      }
      await uow.problems.register({
        problem_id: problemId,
        slug,
        schema_version: 1,
        title,
        created_at: timestamp,
        updated_at: timestamp,
      });
    });

    return Object.freeze({
      status: "passed",
      result: Object.freeze({ slug, title, problemDirectory, problemYamlPath: yamlPath, problemId }),
      diagnostics: Object.freeze([]),
    });
  } catch (error) {
    if (created) {
      await rm(problemDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (isAlreadyExists(error) || error instanceof ExistingProblemError) {
      return failure("invalid_input", "problem_exists", `problem ${JSON.stringify(slug)} already exists`);
    }
    return failure("internal_error", "init_failed", messageOf(error));
  }
}

/** Convert a filesystem-safe slug into the deterministic starter title. */
function titleForSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isDescendant(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !path.includes("\0");
}

class ExistingProblemError extends Error {
  public constructor(slug: string) {
    super(`problem ${JSON.stringify(slug)} is already registered`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unable to initialize problem";
}

function failure(
  status: "invalid_input" | "internal_error",
  code: string,
  message: string,
): InitApplicationOutcome {
  return Object.freeze({
    status,
    result: null,
    diagnostics: Object.freeze([Object.freeze({ code, message })]),
  });
}
