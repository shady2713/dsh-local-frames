import { isAbsolute, normalize, resolve } from 'node:path';
import type { LocalFramesDatabase } from './db.js';
import type { RecentExport, Settings } from './types.js';

const SETTINGS_KEY = 'settings';

/** Recent exports are derived UI history, so the list is capped, not unbounded. */
export const MAX_RECENT_EXPORTS = 10;

/**
 * Defaults fixed by the specification (§12.1): one model slot (unset until the
 * user selects one), a 3000-call budget per task, 2-second frame interval,
 * two concurrent model calls, 40 objects per call and an empty allowlist, which
 * rejects every import until configured.
 *
 * The data-directory cap default is not stated by the specification; it is
 * kept at 50 GB and surfaced on the settings page for the user to change.
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  model: null,
  dataDirLimitGb: 50,
  budgetPerTask: 3000,
  frameIntervalSeconds: 2,
  visionConcurrency: 2,
  objectsPerCall: 40,
  exportDir: null,
  lastImportPath: null,
  allowRoots: [],
  recentExports: [],
});

export const FRAME_INTERVAL_MIN_SECONDS = 1;
export const FRAME_INTERVAL_MAX_SECONDS = 3600;
export const VISION_CONCURRENCY_MIN = 1;
export const VISION_CONCURRENCY_MAX = 8;
export const OBJECTS_PER_CALL_MIN = 1;
export const OBJECTS_PER_CALL_MAX = 80;

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
    visionConcurrency: DEFAULT_SETTINGS.visionConcurrency,
    objectsPerCall: DEFAULT_SETTINGS.objectsPerCall,
    exportDir: null,
    lastImportPath: null,
    allowRoots: [],
    recentExports: [],
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

/**
 * Read an optional absolute path. Missing fields (legacy rows written before the
 * path fields existed) and null/blank values mean "use the default", so an old
 * settings JSON still parses and keeps its allowRoots instead of falling back
 * to defaults.
 */
function readOptionalAbsolutePath(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new SettingsError(`${field} must be null or an absolute path`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 4096) throw new SettingsError(`${field} must be at most 4096 characters`);
  if (!isAbsolute(trimmed)) throw new SettingsError(`${field} must be absolute: ${trimmed}`);
  return resolve(normalize(trimmed));
}

/**
 * Read the recent-export history. It is derived data, not user configuration:
 * a legacy settings row without the field means an empty list, and individual
 * malformed records are dropped instead of resetting every other setting.
 */
function readRecentExports(value: unknown): RecentExport[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  const records: RecentExport[] = [];
  for (const entry of value) {
    if (records.length >= MAX_RECENT_EXPORTS) break;
    if (!isRecord(entry)) continue;
    if (typeof entry.exported_at !== 'string' || !/^\d{4}-/u.test(entry.exported_at)) continue;
    if (typeof entry.task_id !== 'string' || entry.task_id.length === 0) continue;
    if (typeof entry.directory !== 'string' || entry.directory.length === 0) continue;
    if (typeof entry.images !== 'number' || !Number.isInteger(entry.images) || entry.images < 0) continue;
    const targetIds = Array.isArray(entry.target_ids)
      ? entry.target_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const targetNames = Array.isArray(entry.target_names)
      ? entry.target_names.filter((name): name is string => typeof name === 'string')
      : [];
    records.push({
      exported_at: entry.exported_at,
      task_id: entry.task_id,
      target_ids: targetIds,
      target_names: targetNames,
      images: entry.images,
      train: typeof entry.train === 'number' ? entry.train : 0,
      val: typeof entry.val === 'number' ? entry.val : 0,
      directory: entry.directory,
      zip: entry.zip === true,
    });
  }
  return records;
}

const SETTINGS_FIELDS = [
  'model',
  'dataDirLimitGb',
  'budgetPerTask',
  'frameIntervalSeconds',
  'visionConcurrency',
  'objectsPerCall',
  'exportDir',
  'lastImportPath',
  'allowRoots',
  'recentExports',
] as const;

/** Validate one complete settings object; unknown fields are rejected rather than guessed. */
export function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new SettingsError('settings must be a JSON object');
  rejectUnknown(value, SETTINGS_FIELDS, 'settings');
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
    // Rows written before this field existed keep their other values.
    visionConcurrency:
      value.visionConcurrency === undefined
        ? DEFAULT_SETTINGS.visionConcurrency
        : readInteger(value.visionConcurrency, 'visionConcurrency', VISION_CONCURRENCY_MIN, VISION_CONCURRENCY_MAX),
    // Rows written before batching existed keep their other values.
    objectsPerCall:
      value.objectsPerCall === undefined
        ? DEFAULT_SETTINGS.objectsPerCall
        : readInteger(value.objectsPerCall, 'objectsPerCall', OBJECTS_PER_CALL_MIN, OBJECTS_PER_CALL_MAX),
    exportDir: readOptionalAbsolutePath(value.exportDir, 'exportDir'),
    lastImportPath: readOptionalAbsolutePath(value.lastImportPath, 'lastImportPath'),
    allowRoots: readAllowRoots(value.allowRoots),
    recentExports: readRecentExports(value.recentExports),
  };
}

/** Apply a partial patch to the current settings, validating the merged result. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) throw new SettingsError('settings patch must be a JSON object');
  rejectUnknown(patch, SETTINGS_FIELDS, 'settings patch');
  return parseSettings({
    model: 'model' in patch ? patch.model : current.model,
    dataDirLimitGb: 'dataDirLimitGb' in patch ? patch.dataDirLimitGb : current.dataDirLimitGb,
    budgetPerTask: 'budgetPerTask' in patch ? patch.budgetPerTask : current.budgetPerTask,
    frameIntervalSeconds:
      'frameIntervalSeconds' in patch ? patch.frameIntervalSeconds : current.frameIntervalSeconds,
    visionConcurrency: 'visionConcurrency' in patch ? patch.visionConcurrency : current.visionConcurrency,
    objectsPerCall: 'objectsPerCall' in patch ? patch.objectsPerCall : current.objectsPerCall,
    exportDir: 'exportDir' in patch ? patch.exportDir : current.exportDir,
    lastImportPath: 'lastImportPath' in patch ? patch.lastImportPath : current.lastImportPath,
    allowRoots: 'allowRoots' in patch ? patch.allowRoots : current.allowRoots,
    recentExports: 'recentExports' in patch ? patch.recentExports : current.recentExports,
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
