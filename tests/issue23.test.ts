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

describe('issue #23: objectsPerCall default 24', () => {
  it('defaults new settings to 24 and still accepts 1–300 integers', () => {
    expect(DEFAULT_SETTINGS.objectsPerCall).toBe(24);
    expect(defaultSettings().objectsPerCall).toBe(24);
    const base = defaultSettings();
    expect(parseSettings({ ...base, objectsPerCall: 1 }).objectsPerCall).toBe(1);
    expect(parseSettings({ ...base, objectsPerCall: 300 }).objectsPerCall).toBe(300);
    for (const bad of [0, 301, 2.5, Number.NaN]) {
      expect(() => parseSettings({ ...base, objectsPerCall: bad })).toThrow(SettingsError);
    }
  });

  it('migrates a legacy row without the field to 24, not to a stored 40', () => {
    const db = openDatabase(makeTempDir('lf-issue23-legacy-'));
    try {
      db.raw
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
        .run(
          'settings',
          JSON.stringify({
            model: null,
            dataDirLimitGb: 50,
            budgetPerTask: 3000,
            frameIntervalSeconds: 2,
            allowRoots: [],
          }),
        );
      expect(new SettingsStore(db).load().objectsPerCall).toBe(24);
      expect(mergeSettings(defaultSettings(), { frameIntervalSeconds: 3 }).objectsPerCall).toBe(24);
    } finally {
      db.close();
    }
  });

  it('keeps a previously saved 40 unchanged, including after other setting writes', () => {
    const db = openDatabase(makeTempDir('lf-issue23-saved-'));
    try {
      const store = new SettingsStore(db);
      store.update({ objectsPerCall: 40 });
      expect(store.load().objectsPerCall).toBe(40);
      store.update({ budgetPerTask: 1234 });
      store.update({ visionCallTimeoutSeconds: 90 });
      expect(new SettingsStore(db).load().objectsPerCall).toBe(40);
      expect(parseSettings({ ...defaultSettings(), objectsPerCall: 40 }).objectsPerCall).toBe(40);
    } finally {
      db.close();
    }
  });
});
