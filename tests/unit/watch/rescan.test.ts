import { describe, expect, it } from "vitest";

import type { FileSystem } from "../../../src/execution/filesystem.js";
import {
  equalWatchSnapshots,
  isRelevantWatchPath,
  scanWatchTarget,
  stableWatchSnapshot,
} from "../../../src/watch/index.js";

class MemoryFileSystem implements FileSystem {
  public readonly files = new Map<string, { text: string; mtime: number }>();
  public async read(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return new TextEncoder().encode(value.text);
  }
  public async stat(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return {
      sizeBytes: new TextEncoder().encode(value.text).length,
      isFile: true,
      isDirectory: false,
      modifiedMsUtc: value.mtime,
    };
  }
  public async discover(root: string): Promise<readonly string[]> {
    return [...this.files.keys()]
      .filter((path) => path.startsWith(`${root}/`))
      .sort();
  }
  public async createTempRoot(): Promise<string> {
    return "/tmp/fake";
  }
  public watchHints() {
    return { supportsRecursive: false, coalescingMs: 150 };
  }
  public async watch() {
    return { close: async () => undefined };
  }
}

const yaml = [
  "schemaVersion: 1",
  "slug: sample",
  "title: Sample",
  "entrypoint: solution.py",
  "limits: {}",
  "casesDir: cases",
  "args: [int]",
  "returns: int",
].join("\n");
const target = {
  id: "sample",
  slug: "sample",
  problemRoot: "/project/problems/sample",
} as const;
const environment = {};

describe("configured watch snapshots", () => {
  it("includes YAML, solution, recursive cases, and an absent configured override", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set("/project/problems/sample/problem.yaml", {
      text: yaml,
      mtime: 1,
    });
    fs.files.set("/project/problems/sample/solution.py", {
      text: "one",
      mtime: 1,
    });
    fs.files.set("/project/problems/sample/cases/nested/one.json", {
      text: "{}",
      mtime: 1,
    });
    const result = await scanWatchTarget(
      { ...target, solutionOverride: "/project/other.py" },
      {
        fileSystem: fs,
        invocationDirectory: "/project",
        environment,
        unsafeLocal: false,
      },
    );
    expect(result.files.map((file) => [file.path, file.file === null])).toEqual(
      [
        ["/project/other.py", true],
        ["/project/problems/sample/cases/nested/one.json", false],
        ["/project/problems/sample/problem.yaml", false],
      ],
    );
  });

  it("detects content changes even when size and mtime are unchanged", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set("/project/problems/sample/problem.yaml", {
      text: yaml,
      mtime: 1,
    });
    fs.files.set("/project/problems/sample/solution.py", {
      text: "one",
      mtime: 1,
    });
    const before = await scanWatchTarget(target, {
      fileSystem: fs,
      invocationDirectory: "/project",
      environment,
      unsafeLocal: false,
    });
    fs.files.set("/project/problems/sample/solution.py", {
      text: "two",
      mtime: 1,
    });
    const after = await scanWatchTarget(target, {
      fileSystem: fs,
      invocationDirectory: "/project",
      environment,
      unsafeLocal: false,
    });
    expect(equalWatchSnapshots(before, after)).toBe(false);
  });

  it("rejects a snapshot that changes during the 50ms stability interval", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set("/project/problems/sample/problem.yaml", {
      text: yaml,
      mtime: 1,
    });
    fs.files.set("/project/problems/sample/solution.py", {
      text: "one",
      mtime: 1,
    });
    const candidate = await scanWatchTarget(target, {
      fileSystem: fs,
      invocationDirectory: "/project",
      environment,
      unsafeLocal: false,
    });
    const stable = await stableWatchSnapshot(
      target,
      candidate,
      async () => {
        fs.files.set("/project/problems/sample/solution.py", {
          text: "partial",
          mtime: 2,
        });
      },
      {
        fileSystem: fs,
        invocationDirectory: "/project",
        environment,
        unsafeLocal: false,
      },
    );
    expect(stable).toBeNull();
  });

  it("filters notifications to the problem root or explicit solution", () => {
    expect(
      isRelevantWatchPath(target, "/project/problems/sample/cases/one.json"),
    ).toBe(true);
    expect(isRelevantWatchPath(target, "/project/.palestra/judge.sqlite")).toBe(
      false,
    );
    expect(
      isRelevantWatchPath(
        { ...target, solutionOverride: "/project/solution.py" },
        "/project/solution.py",
      ),
    ).toBe(true);
  });
});
