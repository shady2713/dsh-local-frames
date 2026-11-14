import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InputError, validateVideoPath, VIDEO_EXTENSIONS } from '../src/input.js';
import { makeTempDir, writeFixtureFile } from './helpers.js';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('local video path validation', () => {
  it('accepts an absolute file inside the allowlist without modifying it', async () => {
    const root = makeTempDir('lf-root-');
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'not a real video, only a path fixture');
    const before = sha256(file);
    const result = await validateVideoPath(file, { allowRoots: [root] });
    expect(result.kind).toBe('file');
    if (result.kind === 'file') expect(result.bytes).toBeGreaterThan(0);
    expect(sha256(file)).toBe(before);
  });

  it('accepts video extensions case-insensitively', async () => {
    const root = makeTempDir('lf-root-');
    const file = writeFixtureFile(join(root, 'CLIP.MP4'));
    const result = await validateVideoPath(file, { allowRoots: [root] });
    expect(result.kind).toBe('file');
    expect(VIDEO_EXTENSIONS).toContain('.mp4');
  });

  it('accepts a directory input for the later scan stage', async () => {
    const root = makeTempDir('lf-root-');
    const sub = join(root, 'videos');
    mkdirSync(sub);
    const result = await validateVideoPath(sub, { allowRoots: [root] });
    expect(result).toEqual({ kind: 'directory', localPath: sub });
  });

  it('rejects relative, empty and traversal paths', async () => {
    const root = makeTempDir('lf-root-');
    writeFixtureFile(join(root, 'clip.mp4'));
    await expect(validateVideoPath('clip.mp4', { allowRoots: [root] })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(validateVideoPath('', { allowRoots: [root] })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(validateVideoPath(`${root}/../clip.mp4`, { allowRoots: [root] })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(validateVideoPath(42, { allowRoots: [root] })).rejects.toBeInstanceOf(InputError);
  });

  it('rejects every path while the allowlist is empty', async () => {
    const root = makeTempDir('lf-root-');
    const file = writeFixtureFile(join(root, 'clip.mp4'));
    await expect(validateVideoPath(file, { allowRoots: [] })).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('rejects a path outside the allowlist', async () => {
    const root = makeTempDir('lf-root-');
    const outside = makeTempDir('lf-outside-');
    const file = writeFixtureFile(join(outside, 'clip.mp4'));
    await expect(validateVideoPath(file, { allowRoots: [root] })).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink that escapes the allowlist', async () => {
    const root = makeTempDir('lf-root-');
    const outside = makeTempDir('lf-outside-');
    const secret = writeFixtureFile(join(outside, 'secret.mp4'));
    const link = join(root, 'link.mp4');
    symlinkSync(secret, link);
    await expect(validateVideoPath(link, { allowRoots: [root] })).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it.skipIf(process.platform === 'win32')('accepts a symlink that stays inside the allowlist', async () => {
    const root = makeTempDir('lf-root-');
    const real = writeFixtureFile(join(root, 'real.mp4'));
    const link = join(root, 'alias.mp4');
    symlinkSync(real, link);
    const result = await validateVideoPath(link, { allowRoots: [root] });
    expect(result.kind).toBe('file');
  });

  it('rejects missing paths, non-files and empty files', async () => {
    const root = makeTempDir('lf-root-');
    await expect(validateVideoPath(join(root, 'missing.mp4'), { allowRoots: [root] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const empty = writeFixtureFile(join(root, 'empty.mp4'), '');
    await expect(validateVideoPath(empty, { allowRoots: [root] })).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('rejects extensions outside the video whitelist', async () => {
    const root = makeTempDir('lf-root-');
    const file = writeFixtureFile(join(root, 'notes.txt'));
    await expect(validateVideoPath(file, { allowRoots: [root] })).rejects.toMatchObject({ code: 'BAD_EXTENSION' });
  });
});
