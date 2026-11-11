import { dirname } from 'node:path';
import type { SubprocessHandleLike, VersionSubprocess } from './versions.js';

const OPEN_TIMEOUT_MS = 5_000;

function commandFor(platform: NodeJS.Platform): { command: string; args: (directory: string) => string[] } {
  if (platform === 'win32') return { command: 'explorer.exe', args: (directory) => [directory] };
  if (platform === 'darwin') return { command: 'open', args: (directory) => [directory] };
  return { command: 'xdg-open', args: (directory) => [directory] };
}

/**
 * Ask the host to open a directory in its file manager through `ctx.subprocess`.
 * The command is resolved first so a missing opener is reported instead of
 * silently doing nothing. A command still running after the timeout is treated
 * as launched (file managers may stay attached); a non-zero exit is an error.
 */
export async function openHostDirectory(
  subprocess: VersionSubprocess,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { command, args } = commandFor(platform);
  let executable: string | null = null;
  try {
    const resolved = await subprocess.resolveExecutable(command);
    executable = typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  } catch {
    executable = null;
  }
  if (executable === null) throw new Error(`找不到打开目录的命令 ${command}`);

  let handle: SubprocessHandleLike;
  try {
    handle = subprocess.spawn({
      argv: [executable, ...args(directory)],
      cwd: dirname(directory),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4_096 },
        stderr: { maxBytes: 8_192 },
      },
      graceMs: OPEN_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`启动 ${command} 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      handle.terminate();
    } catch {
      // best effort
    }
  }, OPEN_TIMEOUT_MS);
  timer.unref?.();
  let exitCode: number | null;
  try {
    exitCode = (await handle.done).exitCode;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return;
  if (exitCode !== 0) {
    const stderr = handle.collected.stderr.readFrom(0).text.trim();
    throw new Error(stderr.length > 0 ? stderr : `${command} 退出码 ${exitCode === null ? '未知' : exitCode}`);
  }
}
