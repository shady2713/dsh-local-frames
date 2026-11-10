import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Video extensions accepted as files (§5.3). */
export const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];

export type InputErrorCode =
  | 'INVALID_PATH'
  | 'NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'WRONG_TYPE'
  | 'EMPTY_FILE'
  | 'BAD_EXTENSION';

export class InputError extends Error {
  readonly code: InputErrorCode;

  constructor(code: InputErrorCode, message: string) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

export interface PathValidationOptions {
  /** Configured absolute roots; an empty list rejects every path. */
  allowRoots: readonly string[];
}

export type VideoInput =
  | { kind: 'file'; localPath: string; bytes: number }
  | { kind: 'directory'; localPath: string };

function containsTraversal(rawPath: string): boolean {
  const segments = rawPath.split(/[\\/]+/u);
  return segments.some((segment) => segment === '..');
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

function displayPath(rawPath: string): string {
  return rawPath.length > 300 ? `${rawPath.slice(0, 300)}...` : rawPath;
}

/**
 * Validate one local file or directory path (§5.3). The original file is only
 * ever resolved and stat'ed here; nothing is opened for writing.
 */
export async function validateVideoPath(input: unknown, options: PathValidationOptions): Promise<VideoInput> {
  if (typeof input !== 'string') throw new InputError('INVALID_PATH', 'path must be a string');
  const rawPath = input.trim();
  if (rawPath.length === 0) throw new InputError('INVALID_PATH', 'path must not be empty');
  if (rawPath.includes('\0')) throw new InputError('INVALID_PATH', 'path must not contain NUL bytes');
  if (!isAbsolute(rawPath)) {
    throw new InputError('INVALID_PATH', `path must be absolute: ${displayPath(rawPath)}`);
  }
  if (containsTraversal(rawPath)) {
    throw new InputError('INVALID_PATH', `path must not contain ".." segments: ${displayPath(rawPath)}`);
  }

  const roots = options.allowRoots.filter((root): root is string => typeof root === 'string' && isAbsolute(root));
  if (roots.length === 0) {
    throw new InputError('NOT_ALLOWED', '允许读取的视频根目录白名单为空；请先在设置页配置');
  }

  let realTarget: string;
  try {
    realTarget = await realpath(resolve(rawPath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new InputError('NOT_ALLOWED', `没有读取权限：${displayPath(rawPath)}`);
    }
    throw new InputError('NOT_FOUND', `路径不存在：${displayPath(rawPath)}`);
  }

  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // A configured root that no longer exists cannot authorize anything.
    }
  }
  if (!realRoots.some((root) => isInside(root, realTarget))) {
    throw new InputError('NOT_ALLOWED', `路径不在允许的根目录白名单内：${displayPath(rawPath)}`);
  }

  let stats;
  try {
    stats = await stat(realTarget);
  } catch {
    throw new InputError('NOT_FOUND', `路径不存在：${displayPath(rawPath)}`);
  }

  if (stats.isDirectory()) {
    try {
      await access(realTarget, constants.R_OK);
    } catch {
      throw new InputError('NOT_ALLOWED', `目录不可读：${displayPath(rawPath)}`);
    }
    return { kind: 'directory', localPath: realTarget };
  }

  if (!stats.isFile()) {
    throw new InputError('WRONG_TYPE', `路径必须是普通文件或目录：${displayPath(rawPath)}`);
  }

  const extension = extname(realTarget).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(extension)) {
    throw new InputError(
      'BAD_EXTENSION',
      `不支持的视频扩展名 ${extension === '' ? '(无)' : extension}，允许：${VIDEO_EXTENSIONS.join(' ')}`,
    );
  }
  if (stats.size <= 0) throw new InputError('EMPTY_FILE', `文件为空：${displayPath(rawPath)}`);

  try {
    await access(realTarget, constants.R_OK);
  } catch {
    throw new InputError('NOT_ALLOWED', `文件不可读：${displayPath(rawPath)}`);
  }

  return { kind: 'file', localPath: realTarget, bytes: stats.size };
}
