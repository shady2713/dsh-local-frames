import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VersionSubprocess } from './versions.js';

const FRAME_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 60_000;

export interface GrayRaster {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface MediaClient {
  probeDuration(file: string): Promise<{ ok: true; duration: number } | { ok: false; error: string }>;
  extractFrame(
    file: string,
    seconds: number,
    dest: string,
  ): Promise<{ ok: true } | { ok: false; error: string; timedOut: boolean }>;
  decodeGray(file: string, destPgm: string): Promise<{ ok: true; raster: GrayRaster } | { ok: false; error: string }>;
  shrinkJpeg(file: string, dest: string, width: number, height: number): Promise<{ ok: true } | { ok: false; error: string }>;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function clip(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

async function runCommand(
  subprocess: VersionSubprocess,
  cwd: string,
  command: 'ffmpeg' | 'ffprobe',
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  let executable: string;
  try {
    const resolved = await subprocess.resolveExecutable(command);
    if (typeof resolved !== 'string' || resolved.length === 0) {
      return { exitCode: null, stdout: '', stderr: `${command} 不在 PATH 上`, timedOut: false };
    }
    executable = resolved;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: null, stdout: '', stderr: message, timedOut: false };
  }

  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1_048_576 },
      stderr: { maxBytes: 65_536 },
    },
    graceMs: timeoutMs,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      handle.terminate();
    } catch {
      // 超时后尽力结束子进程
    }
  }, timeoutMs);
  timer.unref?.();
  try {
    const outcome = await handle.done;
    const stdout = handle.collected.stdout.readFrom(0).text;
    const stderr = handle.collected.stderr.readFrom(0).text;
    return { exitCode: outcome.exitCode, stdout, stderr, timedOut };
  } catch (error) {
    try {
      handle.terminate();
    } catch {
      // 已经退出
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: null, stdout: '', stderr: message, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function parseDuration(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const format = (parsed as { format?: unknown }).format;
  if (typeof format !== 'object' || format === null) return null;
  const raw = (format as { duration?: unknown }).duration;
  const duration = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return duration;
}

/** Read a binary PGM (P5) written by ffmpeg. */
export function parsePgm(buffer: Buffer): GrayRaster {
  if (buffer.length < 3 || buffer[0] !== 0x50 || buffer[1] !== 0x35) {
    throw new Error('灰度图不是 P5 PGM');
  }
  let offset = 2;
  const tokens: string[] = [];
  while (tokens.length < 3 && offset < buffer.length) {
    const byte = buffer[offset] ?? 0;
    if (byte === 0x23) {
      while (offset < buffer.length && buffer[offset] !== 0x0a) offset += 1;
      offset += 1;
      continue;
    }
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      offset += 1;
      continue;
    }
    const start = offset;
    while (offset < buffer.length) {
      const current = buffer[offset] ?? 0;
      if (current === 0x20 || current === 0x09 || current === 0x0a || current === 0x0d) break;
      offset += 1;
    }
    tokens.push(buffer.toString('ascii', start, offset));
  }
  if (tokens.length < 3) throw new Error('PGM 头不完整');
  const width = Number(tokens[0]);
  const height = Number(tokens[1]);
  const maxval = Number(tokens[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('PGM 尺寸无效');
  }
  if (maxval !== 255) throw new Error('PGM 只接受 8 位灰度');
  while (offset < buffer.length && (buffer[offset] === 0x20 || buffer[offset] === 0x09 || buffer[offset] === 0x0d)) {
    offset += 1;
  }
  if (buffer[offset] === 0x0a) offset += 1;
  const needed = width * height;
  const pixels = buffer.subarray(offset, offset + needed);
  if (pixels.length < needed) throw new Error('PGM 像素数据不完整');
  return { width, height, pixels: Uint8Array.from(pixels) };
}

export function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return null;
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

export function readJpegInfo(file: string): { width: number; height: number; bytes: number } | null {
  const buffer = readFileSync(file);
  const size = jpegSize(buffer);
  if (size === null) return null;
  return { width: size.width, height: size.height, bytes: buffer.length };
}

/**
 * ffmpeg / ffprobe through the host subprocess seam.
 * The two commands specified in §6.1 and §6.4 are passed through unchanged
 * apart from the resolved executable path.
 */
export function createFfmpegMedia(subprocess: VersionSubprocess, cwd: string): MediaClient {
  return {
    async probeDuration(file) {
      const result = await runCommand(
        subprocess,
        cwd,
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
        PROBE_TIMEOUT_MS,
      );
      if (result.timedOut) return { ok: false, error: 'ffprobe 超时' };
      if (result.exitCode !== 0) {
        return { ok: false, error: clip(result.stderr) || `ffprobe 退出码 ${result.exitCode ?? 'null'}` };
      }
      const duration = parseDuration(result.stdout);
      if (duration === null) return { ok: false, error: 'ffprobe 没有读出时长' };
      return { ok: true, duration };
    },

    async extractFrame(file, seconds, dest) {
      mkdirSync(dirname(dest), { recursive: true });
      const stamp = Number.isFinite(seconds) && seconds >= 0 ? seconds.toFixed(3) : '0.000';
      const result = await runCommand(
        subprocess,
        cwd,
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          stamp,
          '-i',
          file,
          '-frames:v',
          '1',
          '-pix_fmt',
          'yuvj420p',
          '-q:v',
          '2',
          '-update',
          '1',
          '-y',
          dest,
        ],
        FRAME_TIMEOUT_MS,
      );
      if (result.timedOut) return { ok: false, error: '取帧超过 60 秒', timedOut: true };
      if (result.exitCode !== 0) {
        return { ok: false, error: clip(result.stderr) || `ffmpeg 退出码 ${result.exitCode ?? 'null'}`, timedOut: false };
      }
      try {
        if (statSync(dest).size <= 0) return { ok: false, error: '取帧结果是空文件', timedOut: false };
      } catch {
        return { ok: false, error: '取帧没有写出文件', timedOut: false };
      }
      return { ok: true };
    },

    async decodeGray(file, destPgm) {
      mkdirSync(dirname(destPgm), { recursive: true });
      const result = await runCommand(
        subprocess,
        cwd,
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          file,
          '-vf',
          'scale=1024:1024:force_original_aspect_ratio=decrease,format=gray',
          '-frames:v',
          '1',
          '-y',
          destPgm,
        ],
        FRAME_TIMEOUT_MS,
      );
      if (result.timedOut || result.exitCode !== 0) {
        return { ok: false, error: result.timedOut ? '灰度解码超时' : clip(result.stderr) || '灰度解码失败' };
      }
      try {
        const raster = parsePgm(readFileSync(destPgm));
        return { ok: true, raster };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '灰度解码失败' };
      }
    },

    async shrinkJpeg(file, dest, width, height) {
      mkdirSync(dirname(dest), { recursive: true });
      const safeWidth = Math.max(2, width - (width % 2));
      const safeHeight = Math.max(2, height - (height % 2));
      const result = await runCommand(
        subprocess,
        cwd,
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          file,
          '-vf',
          `scale=${safeWidth}:${safeHeight}`,
          '-frames:v',
          '1',
          '-q:v',
          '5',
          '-update',
          '1',
          '-y',
          dest,
        ],
        FRAME_TIMEOUT_MS,
      );
      if (result.timedOut || result.exitCode !== 0) {
        return { ok: false, error: result.timedOut ? '缩小图片超时' : clip(result.stderr) || '缩小图片失败' };
      }
      return { ok: true };
    },
  };
}
