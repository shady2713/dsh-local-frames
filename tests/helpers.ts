import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll } from 'vitest';
import type { SubprocessHandleLike, SubprocessSpawnSpecLike, VersionSubprocess } from '../src/versions.js';

const createdDirs: string[] = [];

/** Temporary directories live in the OS temp area, never in the user's data directory. */
export function makeTempDir(prefix = 'local-frames-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/** Create a synthetic file used only for path-validation tests, never as video acceptance. */
export function writeFixtureFile(path: string, bytes = 'fixture'): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

export interface MockRequestOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function mockRequest(options: MockRequestOptions = {}): IncomingMessage {
  const body = options.body;
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body, 'utf8')]);
  return Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage;
}

export interface MockResponseResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  json(): unknown;
}

export function mockResponse(): { res: ServerResponse; result: MockResponseResult } {
  const result: MockResponseResult = {
    status: 0,
    headers: {},
    body: '',
    json() {
      return JSON.parse(result.body) as unknown;
    },
  };
  const res = {
    headersSent: false,
    statusCode: 200,
    writeHead(status: number, headers: Record<string, string>) {
      result.status = status;
      result.headers = headers;
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') result.body += chunk;
      this.headersSent = true;
    },
  };
  return { res: res as unknown as ServerResponse, result };
}

export interface FakeCommand {
  /** Executable path; omitted means the executable is missing from PATH. */
  path?: string;
  /** stdout text for a successful run. */
  output?: string;
  exitCode?: number;
  stderr?: string;
  /** Synchronously throw from spawn, simulating a failed start. */
  spawnError?: string;
}

export interface FakeSubprocess extends VersionSubprocess {
  readonly calls: string[];
  readonly spawns: string[][];
}

/**
 * Deterministic ctx.subprocess stand-in for environment tests. It records the
 * commands it was asked to resolve and the argv it was asked to spawn.
 */
export function fakeSubprocess(commands: Record<string, FakeCommand>): FakeSubprocess {
  const calls: string[] = [];
  const spawns: string[][] = [];
  return {
    calls,
    spawns,
    async resolveExecutable(command: string): Promise<string | null> {
      calls.push(command);
      const entry = commands[command];
      if (entry === undefined || entry.path === undefined) throw new Error(`${command}: not found`);
      return entry.path;
    },
    spawn(spec: SubprocessSpawnSpecLike): SubprocessHandleLike {
      spawns.push([...spec.argv]);
      const command = spec.argv[0] ?? '';
      const name = command.split(/[\\/]/u).pop() ?? command;
      const entry = commands[name];
      if (entry === undefined) throw new Error(`unexpected command ${command}`);
      if (entry.spawnError !== undefined) throw new Error(entry.spawnError);
      const output = entry.output ?? '';
      return {
        collected: {
          stdout: {
            readFrom: () => ({ text: output, nextOffset: output.length, lossy: false }),
          },
          stderr: {
            readFrom: () => ({ text: entry.stderr ?? '', nextOffset: (entry.stderr ?? '').length, lossy: false }),
          },
        },
        done: Promise.resolve({ exitCode: entry.exitCode ?? 0, signal: null }),
        terminate: () => undefined,
      };
    },
  };
}

/** A subprocess where every expected tool prints a plausible version. */
export function healthySubprocess(): FakeSubprocess {
  return fakeSubprocess({
    npm: { path: '/usr/bin/npm', output: '11.21.1\n' },
    ffmpeg: { path: '/usr/bin/ffmpeg', output: 'ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026\n' },
    ffprobe: { path: '/usr/bin/ffprobe', output: 'ffprobe version 7.1.5-0+deb13u1 Copyright (c) 2007-2026\n' },
    git: { path: '/usr/bin/git', output: 'git version 2.47.3\n' },
  });
}

export function fakeExec(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

export function joinPath(...parts: string[]): string {
  return join(...parts);
}
