import { isAbsolute, normalize, resolve } from 'node:path';
import type { LocalFramesDatabase } from './db.js';
import type { Settings } from './types.js';

const SETTINGS_KEY = 'settings';

/**
 * Defaults fixed by the specification (§12.1): one model slot (unset until the
 * user selects one), a 3000-call budget per task, 2-second frame interval and
 * an empty allowlist, which rejects every import until configured.
 *
 * The data-directory cap default is not stated by the specification; it is
 * kept at 50 GB and surfaced on the settings page for the user to change.
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  model: null,
  dataDirLimitGb: 50,
  budgetPerTask: 3000,
  frameIntervalSeconds: 2,
  allowRoots: [],
});

export const FRAME_INTERVAL_MIN_SECONDS = 1;
export const FRAME_INTERVAL_MAX_SECONDS = 3600;

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export function defaultSettings(): Settings {
  return {
    model: null,
    dataDirLimitGb: DEFAULT_SETTINGS.dataDirLimitGb,
    budgetPerTask: DEFAULT_SETTINGS.budgetPerTask,
    frameIntervalSeconds: DEFAULT_SETTINGS.frameIntervalSeconds,
    allowRoots: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new SettingsError(`${where} has unknown field "${key}"`);
  }
}

function readModel(value: unknown): Settings['model'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new SettingsError('model must be null or an object');
  rejectUnknown(value, ['provider', 'model'], 'model');
  const provider = value.provider;
  const model = value.model;
  if (typeof provider !== 'string' || provider.trim().length === 0 || provider.length > 200) {
    throw new SettingsError('model.provider must be a non-empty string');
  }
  if (typeof model !== 'string' || model.trim().length === 0 || model.length > 200) {
    throw new SettingsError('model.model must be a non-empty string');
  }
  return { provider: provider.trim(), model: model.trim() };
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readAllowRoots(value: unknown): string[] {
  if (!Array.isArray(value)) throw new SettingsError('allowRoots must be an array of absolute paths');
  if (value.length > 100) throw new SettingsError('allowRoots must have at most 100 entries');
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new SettingsError('allowRoots must contain strings');
    const trimmed = entry.trim();
    if (trimmed.length === 0) throw new SettingsError('allowRoots must not contain empty paths');
    if (!isAbsolute(trimmed)) throw new SettingsError(`allowRoots entry must be absolute: ${trimmed}`);
    const normalized = resolve(normalize(trimmed));
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

/** Validate one complete settings object; unknown fields are rejected rather than guessed. */
export function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new SettingsError('settings must be a JSON object');
  rejectUnknown(
    value,
    ['model', 'dataDirLimitGb', 'budgetPerTask', 'frameIntervalSeconds', 'allowRoots'],
    'settings',
  );
  return {
    model: readModel(value.model),
    dataDirLimitGb: readInteger(value.dataDirLimitGb, 'dataDirLimitGb', 1, 1_000_000),
    budgetPerTask: readInteger(value.budgetPerTask, 'budgetPerTask', 1, 2_147_483_647),
    frameIntervalSeconds: readInteger(
      value.frameIntervalSeconds,
      'frameIntervalSeconds',
      FRAME_INTERVAL_MIN_SECONDS,
      FRAME_INTERVAL_MAX_SECONDS,
    ),
    allowRoots: readAllowRoots(value.allowRoots),
  };
}

/** Apply a partial patch to the current settings, validating the merged result. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) throw new SettingsError('settings patch must be a JSON object');
  rejectUnknown(
    patch,
    ['model', 'dataDirLimitGb', 'budgetPerTask', 'frameIntervalSeconds', 'allowRoots'],
    'settings patch',
  );
  return parseSettings({
    model: 'model' in patch ? patch.model : current.model,
    dataDirLimitGb: 'dataDirLimitGb' in patch ? patch.dataDirLimitGb : current.dataDirLimitGb,
    budgetPerTask: 'budgetPerTask' in patch ? patch.budgetPerTask : current.budgetPerTask,
    frameIntervalSeconds:
      'frameIntervalSeconds' in patch ? patch.frameIntervalSeconds : current.frameIntervalSeconds,
    allowRoots: 'allowRoots' in patch ? patch.allowRoots : current.allowRoots,
  });
}

type Logger = (message: string) => void;

/** Settings persistence over the plugin's own `settings` table (never DSH plugin config). */
export class SettingsStore {
  private readonly db: LocalFramesDatabase;
  private readonly log: Logger;

  constructor(db: LocalFramesDatabase, log: Logger = () => undefined) {
    this.db = db;
    this.log = log;
  }

  load(): Settings {
    const row = this.db.raw.prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      | { value_json?: string }
      | undefined;
    if (typeof row?.value_json !== 'string') return defaultSettings();
    try {
      return parseSettings(JSON.parse(row.value_json) as unknown);
    } catch (error) {
      this.log(`stored settings are invalid; using defaults: ${error instanceof Error ? error.message : String(error)}`);
      return defaultSettings();
    }
  }

  save(settings: Settings): Settings {
    const validated = parseSettings(settings);
    this.db.raw
      .prepare(
        'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      )
      .run(SETTINGS_KEY, JSON.stringify(validated));
    return validated;
  }

  update(patch: unknown): Settings {
    return this.save(mergeSettings(this.load(), patch));
  }
}
