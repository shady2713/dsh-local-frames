import { unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Only frame files the plugin itself wrote may be removed. User videos are never in this directory. */
export function removeOwnedFrame(dataDir: string, framePath: string | null | undefined): void {
  if (framePath === null || framePath === undefined || framePath.length === 0) return;
  const root = resolve(dataDir, 'frames');
  const target = resolve(framePath);
  const rel = relative(root, target);
  const inside = rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  if (!inside) {
    throw new Error('拒绝删除帧目录以外的文件');
  }
  try {
    unlinkSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}
