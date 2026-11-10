import { readdirSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Specification §15.1: a task pauses when the volume has less free space than this. */
export const DEFAULT_MIN_FREE_DISK_GB = 10;

export function freeDiskGb(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(available) || available < 0) return null;
    return available / 1e9;
  } catch {
    return null;
  }
}

/** Total bytes of all regular files below a directory; unreadable entries are skipped. */
export function directorySizeBytes(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) total += statSync(path).size;
      } catch {
        // skip unreadable or vanished entries
      }
    }
  };
  walk(dir);
  return total;
}
