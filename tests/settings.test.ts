import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  DEFAULT_SETTINGS,
  defaultSettings,
  mergeSettings,
  parseSettings,
  SettingsError,
  SettingsStore,
} from '../src/settings.js';
import { makeTempDir } from './helpers.js';

describe('settings defaults and validation', () => {
  it('uses the specification defaults', () => {
    const settings = defaultSettings();
    expect(settings.model).toBeNull();
    expect(settings.budgetPerTask).toBe(3000);
    expect(settings.frameIntervalSeconds).toBe(2);
    expect(settings.allowRoots).toEqual([]);
    expect(settings.dataDirLimitGb).toBe(DEFAULT_SETTINGS.dataDirLimitGb);
  });

  it('accepts the frame-interval boundaries and rejects values outside 1..3600', () => {
    const base = defaultSettings();
    expect(parseSettings({ ...base, frameIntervalSeconds: 1 }).frameIntervalSeconds).toBe(1);
    expect(parseSettings({ ...base, frameIntervalSeconds: 3600 }).frameIntervalSeconds).toBe(3600);
    expect(() => parseSettings({ ...base, frameIntervalSeconds: 0 })).toThrow(SettingsError);
    expect(() => parseSettings({ ...base, frameIntervalSeconds: 3601 })).toThrow(SettingsError);
    expect(() => parseSettings({ ...base, frameIntervalSeconds: 2.5 })).toThrow(SettingsError);
  });

  it('validates the single model slot', () => {
    const base = defaultSettings();
    expect(parseSettings({ ...base, model: { provider: 'p', model: 'm' } }).model).toEqual({
      provider: 'p',
      model: 'm',
    });
    expect(() => parseSettings({ ...base, model: { provider: '', model: 'm' } })).toThrow(SettingsError);
    expect(() => parseSettings({ ...base, model: { provider: 'p', model: 'm', extra: true } })).toThrow(
      /unknown field/,
    );
  });

  it('requires absolute allow roots and normalizes them', () => {
    const base = defaultSettings();
    const relative = parseSettingsSafe({ ...base, allowRoots: ['relative/path'] });
    expect(relative).toContain('must be absolute');
    const settings = parseSettings({ ...base, allowRoots: ['/tmp/media', '/tmp/media/', '/tmp/other'] });
    expect(settings.allowRoots).toHaveLength(2);
    for (const root of settings.allowRoots) expect(isAbsolute(root)).toBe(true);
  });

  it('rejects unknown top-level fields instead of guessing', () => {
    expect(() => parseSettings({ ...defaultSettings(), secret: 'x' })).toThrow(/unknown field/);
  });

  it('merges a partial patch without losing other values', () => {
    const current = defaultSettings();
    const merged = mergeSettings(current, { frameIntervalSeconds: 5, allowRoots: ['/tmp/media'] });
    expect(merged.frameIntervalSeconds).toBe(5);
    expect(merged.budgetPerTask).toBe(3000);
    expect(merged.allowRoots).toEqual(['/tmp/media']);
  });

  it('persists settings in the plugin table and falls back to defaults for corrupt rows', () => {
    const db = openDatabase(makeTempDir());
    try {
      const store = new SettingsStore(db);
      expect(store.load()).toEqual(defaultSettings());
      store.update({ frameIntervalSeconds: 10, budgetPerTask: 7 });
      expect(store.load().frameIntervalSeconds).toBe(10);
      expect(store.load().budgetPerTask).toBe(7);
      db.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run('{', 'settings');
      expect(store.load()).toEqual(defaultSettings());
    } finally {
      db.close();
    }
  });
});

function parseSettingsSafe(value: unknown): string {
  try {
    parseSettings(value);
    return 'accepted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
