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
    expect(settings.exportDir).toBeNull();
    expect(settings.lastImportPath).toBeNull();
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

  it('accepts absolute export and import paths and rejects relative values', () => {
    const base = defaultSettings();
    const settings = parseSettings({
      ...base,
      exportDir: '/tmp/local-frames-exports/',
      lastImportPath: '/tmp/local-frames-media/in',
    });
    expect(settings.exportDir).toBe('/tmp/local-frames-exports');
    expect(settings.lastImportPath).toBe('/tmp/local-frames-media/in');
    const unset = parseSettings({ ...base, exportDir: null, lastImportPath: null });
    expect(unset.exportDir).toBeNull();
    expect(unset.lastImportPath).toBeNull();
    expect(() => parseSettings({ ...base, exportDir: 'exports' })).toThrow(/exportDir must be absolute/);
    expect(() => parseSettings({ ...base, lastImportPath: '../media' })).toThrow(/lastImportPath must be absolute/);
    expect(() => parseSettings({ ...base, exportDir: 42 })).toThrow(/exportDir must be null or an absolute path/);
  });

  it('merges a partial patch without losing other values', () => {
    const current = defaultSettings();
    const merged = mergeSettings(current, {
      frameIntervalSeconds: 5,
      exportDir: '/tmp/local-frames-exports',
      lastImportPath: '/tmp/local-frames-media',
    });
    expect(merged.frameIntervalSeconds).toBe(5);
    expect(merged.budgetPerTask).toBe(3000);
    expect(merged.exportDir).toBe('/tmp/local-frames-exports');
    expect(merged.lastImportPath).toBe('/tmp/local-frames-media');
    expect(merged.allowRoots).toEqual([]);
  });

  it('rejects unknown top-level fields instead of guessing', () => {
    expect(() => parseSettings({ ...defaultSettings(), secret: 'x' })).toThrow(/unknown field/);
  });

  it('loads legacy settings rows without the path fields instead of resetting allowRoots', () => {
    const db = openDatabase(makeTempDir());
    try {
      const root = makeTempDir('lf-legacy-root-');
      const legacy = {
        model: null,
        dataDirLimitGb: 50,
        budgetPerTask: 3000,
        frameIntervalSeconds: 2,
        allowRoots: [root],
      };
      db.raw
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
        .run('settings', JSON.stringify(legacy));
      const settings = new SettingsStore(db).load();
      expect(settings.allowRoots).toEqual([root]);
      expect(settings.exportDir).toBeNull();
      expect(settings.lastImportPath).toBeNull();
    } finally {
      db.close();
    }
  });

  it('saves the allowlist on the first write and shows it after reopening the store', () => {
    const db = openDatabase(makeTempDir());
    try {
      const root = makeTempDir('lf-first-save-root-');
      expect(new SettingsStore(db).load().allowRoots).toEqual([]);
      new SettingsStore(db).update({ allowRoots: [root] });
      expect(new SettingsStore(db).load().allowRoots).toEqual([root]);
    } finally {
      db.close();
    }
  });

  it('persists the export directory across store instances', () => {
    const db = openDatabase(makeTempDir());
    try {
      const exportDir = makeTempDir('lf-export-target-');
      new SettingsStore(db).update({ exportDir });
      expect(new SettingsStore(db).load().exportDir).toBe(exportDir);
    } finally {
      db.close();
    }
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
