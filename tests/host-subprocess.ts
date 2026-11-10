import { spawn } from 'node:child_process';
import type { SubprocessHandleLike, SubprocessSpawnSpecLike, VersionSubprocess } from '../src/versions.js';

/**
 * Test double for ctx.subprocess that runs the real ffmpeg and ffprobe.
 * The plugin itself never imports node:child_process.
 */
export function hostSubprocess(): VersionSubprocess {
  return {
    async resolveExecutable(command: string): Promise<string> {
      if (command === 'ffmpeg') return '/usr/bin/ffmpeg';
      if (command === 'ffprobe') return '/usr/bin/ffprobe';
      throw new Error(`${command}: not found`);
    },
    spawn(spec: SubprocessSpawnSpecLike): SubprocessHandleLike {
      const child = spawn(spec.argv[0] ?? '', spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const maxOut = spec.stdio.stdout.maxBytes;
      const maxErr = spec.stdio.stderr.maxBytes;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < maxOut) stdout += chunk.slice(0, maxOut - stdout.length);
      });
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < maxErr) stderr += chunk.slice(0, maxErr - stderr.length);
      });
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        done: new Promise((resolve) => {
          child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }));
        }),
        terminate() {
          child.kill('SIGKILL');
        },
      };
    },
  };
}

export function runChecked(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0] ?? '', args.slice(1), { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(' ')} exited ${code ?? 'null'}`));
    });
  });
}
