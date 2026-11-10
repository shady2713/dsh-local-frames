import { readFileSync } from 'node:fs';

/**
 * The plugin version has one source: package.json. The compiled module lives
 * in lib/src at runtime; the source module is used directly by tests.
 */
export function pluginVersion(): string {
  const candidates = [
    new URL('../../package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
    new URL('./package.json', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
      if (parsed.name === 'dsh-local-frames' && typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}
