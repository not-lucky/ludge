/**
 * Test-only fake `uv` runtime used by compiled-CLI black-box suites.
 *
 * The generated executable is selected only through an explicit fixture
 * `PALESTRA_UV_PATH`. It records the actual sanitized child environment and
 * launch facts, then can emit a protocol response or controlled process facts.
 * Production code never imports this helper or searches for this executable.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Versioned behavior document consumed by the generated fake executable. */
export interface FakeUvControl {
  readonly schemaVersion: 1;
  readonly mode?:
    | "echo"
    | "constant"
    | "malformed"
    | "exit"
    | "signal"
    | "sleep"
    | "cpu"
    | "memory"
    | "stdout"
    | "stderr"
    | "fork"
    | "write";
  readonly value?: unknown;
  readonly exitCode?: number;
  readonly signal?: "SIGXCPU" | "SIGXFSZ" | "SIGKILL" | "SIGTERM";
  readonly milliseconds?: number;
  readonly bytes?: number;
  readonly path?: string;
}

/** Paths and environment values for one isolated fake runtime. */
export interface FakeUvRuntime {
  readonly directory: string;
  readonly executable: string;
  readonly pythonPath: string;
  readonly cacheDirectory: string;
  readonly controlPath: string;
  readonly recordPath: string;
  writeControl(control: FakeUvControl): Promise<void>;
  records(): Promise<readonly FakeUvLaunchRecord[]>;
}

/** Full fact captured at the fake runtime boundary. */
export interface FakeUvLaunchRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const EXECUTABLE_SOURCE = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const controlPath = process.env.UV_CACHE_DIR + '/fake-uv-control.json';
const recordPath = process.env.UV_CACHE_DIR + '/fake-uv-records.jsonl';
appendFileSync(recordPath, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), environment: process.env }) + '\\n');
const control = JSON.parse(readFileSync(controlPath, 'utf8'));
const request = JSON.parse(readFileSync(0, 'utf8').trim());
const mode = control.mode || 'echo';
const response = (output) => JSON.stringify({ protocolVersion: 1, kind: 'response', runId: request.runId, caseId: request.caseId, codecVersion: request.codecVersion, messageLimitBytes: request.messageLimitBytes, output, exception: null }) + '\\n';
if (mode === 'malformed') { process.stdout.write('{not-json}\\n'); process.exit(0); }
if (mode === 'exit') { process.stderr.write('configured exit\\n'); process.exit(control.exitCode || 1); }
if (mode === 'signal') { process.kill(process.pid, control.signal || 'SIGTERM'); }
if (mode === 'sleep') { setTimeout(() => process.stdout.write(response(request.input)), control.milliseconds || 10_000); return; }
if (mode === 'cpu') { while (true) {} }
if (mode === 'memory') { const blocks = []; while (true) blocks.push(Buffer.alloc(control.bytes || 8 * 1024 * 1024)); }
if (mode === 'stdout') { process.stdout.write('x'.repeat(control.bytes || 1_000_000)); return; }
if (mode === 'stderr') { process.stderr.write('x'.repeat(control.bytes || 1_000_000)); process.exit(1); }
if (mode === 'fork') { const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: false, stdio: 'ignore' }); appendFileSync(recordPath, JSON.stringify({ descendantPid: child.pid }) + '\\n'); setTimeout(() => process.stdout.write(response(request.input)), control.milliseconds || 30_000); return; }
if (mode === 'write') { writeFileSync(control.path || '/tmp/palestra-fake-output', 'x'.repeat(control.bytes || 1)); process.stdout.write(response(request.input)); return; }
process.stdout.write(response(mode === 'constant' ? control.value : request.input));
`;

/** Create a fake `uv` executable and private control/record directory. */
export async function createFakeUvRuntime(
  root: string,
): Promise<FakeUvRuntime> {
  const directory = join(root, "runtime");
  const cacheDirectory = join(directory, "cache");
  const executable = join(directory, "uv");
  const pythonPath = process.execPath;
  const controlPath = join(cacheDirectory, "fake-uv-control.json");
  const recordPath = join(cacheDirectory, "fake-uv-records.jsonl");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(executable, EXECUTABLE_SOURCE, { mode: 0o755 });
  await chmod(executable, 0o755);
  const runtime: FakeUvRuntime = {
    directory,
    executable,
    pythonPath,
    cacheDirectory,
    controlPath,
    recordPath,
    async writeControl(control): Promise<void> {
      await writeFile(controlPath, JSON.stringify(control));
    },
    async records(): Promise<readonly FakeUvLaunchRecord[]> {
      try {
        return (await readFile(recordPath, "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as FakeUvLaunchRecord)
          .filter((record) => "argv" in record);
      } catch {
        return [];
      }
    },
  };
  await runtime.writeControl({ schemaVersion: 1 });
  return runtime;
}
