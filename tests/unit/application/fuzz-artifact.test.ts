import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fuzzArtifactId,
  writeFuzzArtifact,
  type FuzzArtifactDocument,
} from "../../../src/application/fuzz-artifact.js";
import { createResourceLimits } from "../../../src/domain/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function document(): FuzzArtifactDocument {
  const envelope = {
    status: "passed",
    exitCode: 0,
    signal: null,
    stdoutBase64Url: "",
    stderrBase64Url: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    wallTimeMs: 0,
    cpuTimeMs: 0,
    memoryPeakBytes: 0,
    termination: "exited",
    exception: null,
    output: null,
  } as const;
  return {
    schemaVersion: 1,
    kind: "fuzz-finding",
    sourceRunId: "run",
    sourceCaseId: "case",
    slug: "two-sum",
    seed: "1",
    caseIndex: 0,
    inputCodecVersion: "tagged-jsonl-v1",
    outputCodecVersion: "tagged-jsonl-v1",
    comparatorVersion: "exact-v1",
    runtime: "python-uv",
    limits: createResourceLimits({
      wallTimeMs: 1,
      cpuTimeMs: 1,
      memoryBytes: 1,
      stdoutBytes: 1,
      stderrBytes: 1,
      combinedOutputBytes: 1,
      inputBytes: 1,
      fileSizeBytes: 1,
      processCount: 1,
      openDescriptors: 1,
      tempStorageBytes: 1,
      concurrencyPerCase: 1,
    }),
    generatorPath: "generator.py",
    naivePath: "naive.py",
    solutionPath: "solution.py",
    originalInputBase64Url: "AA",
    minimizedInputBase64Url: "AA",
    predicate: {
      kind: "mismatch",
      naiveStatus: "passed",
      solutionStatus: "passed",
      mismatchPath: "$",
      mismatchReason: "different",
    },
    naive: envelope,
    solution: envelope,
    shrink: {
      requested: false,
      steps: 0,
      reason: "not_requested",
      originalBytes: 0,
      minimizedBytes: 0,
    },
    createdAt: "2020-01-01T00:00:00.000Z",
  };
}

describe("fuzz artifact store", () => {
  it("writes the content-addressed artifact atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palestra-artifact-"));
    directories.push(directory);
    const source = document();
    const stored = await writeFuzzArtifact(directory, source, undefined);
    expect(stored.artifactId).toBe(fuzzArtifactId(source));
    expect(await readdir(join(directory, ".palestra", "artifacts"))).toEqual([
      stored.artifactId,
    ]);
  });

  it("rejects a new artifact at cap without evicting an existing artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palestra-artifact-"));
    directories.push(directory);
    const stored = await writeFuzzArtifact(directory, document(), undefined);
    await expect(
      writeFuzzArtifact(
        directory,
        { ...document(), sourceRunId: "different" },
        Number(stored.sizeBytes),
      ),
    ).rejects.toThrow("storage cap");
    expect(await readdir(join(directory, ".palestra", "artifacts"))).toEqual([
      stored.artifactId,
    ]);
  });
});
