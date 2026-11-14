import { isAbsolute, normalize, resolve } from 'node:path';
import type { LocalFramesDatabase } from './db.js';
import type { ModelPoolEntry, RecentExport, Settings } from './types.js';

const SETTINGS_KEY = 'settings';

/** Recent exports are derived UI history, so the list is capped, not unbounded. */
export const MAX_RECENT_EXPORTS = 10;

/**
 * Defaults fixed by the specification (§12.1): an empty model pool (judging is
 * paused until the user adds a model), a 3000-call budget per task, a 2-second
 * frame interval, 40 objects per call, a 120-second call timeout and an empty
 * allowlist, which rejects every import until configured.
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
  visionCallTimeoutSeconds: 120,
  modelPool: [],
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
export const OBJECTS_PER_CALL_MAX = 300;
export const VISION_CALL_TIMEOUT_MIN_SECONDS = 60;
export const VISION_CALL_TIMEOUT_MAX_SECONDS = 300;
/** The model pool may contain at most this many rows. */
export const MODEL_POOL_MAX_ENTRIES = 5;
/** Sum of all per-model call concurrency values; also the runtime in-flight cap. */
export const MODEL_POOL_TOTAL_CONCURRENCY_MAX = 16;
/** Concurrency used for a newly added pool row (and for legacy single-model rows). */
export const MODEL_POOL_DEFAULT_CONCURRENCY = 2;

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
    visionCallTimeoutSeconds: DEFAULT_SETTINGS.visionCallTimeoutSeconds,
    modelPool: [],
    exportDir: null,
    lastImportPath: null,
    allowRoots: [],
    recentExports: [],
  };
}

/** The `provider/model` string persisted in `calls.model`, capped to 200 characters. */
export function callModelName(choice: { provider: string; model: string }): string {
  return `${choice.provider}/${choice.model}`.slice(0, 200);
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

/**
 * Validate the model pool. Rows are kept in order because that order breaks
 * ties when a new frame is assigned to a model. An empty pool is valid and
 * simply prevents judging (NO_MODEL), matching the old unset single model.
 */
function readModelPool(value: unknown): ModelPoolEntry[] {
  if (!Array.isArray(value)) throw new SettingsError('modelPool must be an array');
  if (value.length > MODEL_POOL_MAX_ENTRIES) {
    throw new SettingsError(`modelPool must have at most ${MODEL_POOL_MAX_ENTRIES} entries`);
  }
  const entries: ModelPoolEntry[] = [];
  const seen = new Set<string>();
  let totalConcurrency = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const where = `modelPool[${index}]`;
    if (!isRecord(entry)) throw new SettingsError(`${where} must be an object`);
    rejectUnknown(entry, ['provider', 'model', 'concurrency'], where);
    const provider = entry.provider;
    const model = entry.model;
    if (typeof provider !== 'string' || provider.trim().length === 0 || provider.length > 200) {
      throw new SettingsError(`${where}.provider must be a non-empty string`);
    }
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 200) {
      throw new SettingsError(`${where}.model must be a non-empty string`);
    }
    const concurrency = readInteger(
      entry.concurrency,
      `${where}.concurrency`,
      VISION_CONCURRENCY_MIN,
      VISION_CONCURRENCY_MAX,
    );
    const providerName = provider.trim();
    const modelName = model.trim();
    const key = `${providerName}\u0000${modelName}`;
    if (seen.has(key)) throw new SettingsError(`${where} duplicates model ${providerName}/${modelName}`);
    seen.add(key);
    totalConcurrency += concurrency;
    if (totalConcurrency > MODEL_POOL_TOTAL_CONCURRENCY_MAX) {
      throw new SettingsError(
        `modelPool concurrency total must be at most ${MODEL_POOL_TOTAL_CONCURRENCY_MAX}`,
      );
    }
    entries.push({ provider: providerName, model: modelName, concurrency });
  }
  return entries;
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
  'visionCallTimeoutSeconds',
  'modelPool',
  'exportDir',
  'lastImportPath',
  'allowRoots',
  'recentExports',
] as const;

/**
 * Validate one complete settings object; unknown fields are rejected rather
 * than guessed. `modelPool` is authoritative: rows without it are migrated
 * from the legacy single `model` slot. The legacy `model` and
 * `visionConcurrency` fields are retained for old rows and old writers but are
 * never used to schedule model calls.
 */
export function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new SettingsError('settings must be a JSON object');
  rejectUnknown(value, SETTINGS_FIELDS, 'settings');
  const legacyModel = readModel(value.model);
  // Rows written before this field existed keep their other values.
  const legacyConcurrency =
    value.visionConcurrency === undefined
      ? DEFAULT_SETTINGS.visionConcurrency
      : readInteger(value.visionConcurrency, 'visionConcurrency', VISION_CONCURRENCY_MIN, VISION_CONCURRENCY_MAX);
  const modelPool =
    'modelPool' in value
      ? readModelPool(value.modelPool)
      : legacyModel === null
        ? []
        : [{ provider: legacyModel.provider, model: legacyModel.model, concurrency: legacyConcurrency }];
  return {
    model: legacyModel,
    dataDirLimitGb: readInteger(value.dataDirLimitGb, 'dataDirLimitGb', 1, 1_000_000),
    budgetPerTask: readInteger(value.budgetPerTask, 'budgetPerTask', 1, 2_147_483_647),
    frameIntervalSeconds: readInteger(
      value.frameIntervalSeconds,
      'frameIntervalSeconds',
      FRAME_INTERVAL_MIN_SECONDS,
      FRAME_INTERVAL_MAX_SECONDS,
    ),
    visionConcurrency: legacyConcurrency,
    // Rows written before batching existed keep their other values.
    objectsPerCall:
      value.objectsPerCall === undefined
        ? DEFAULT_SETTINGS.objectsPerCall
        : readInteger(value.objectsPerCall, 'objectsPerCall', OBJECTS_PER_CALL_MIN, OBJECTS_PER_CALL_MAX),
    // Rows written before the timeout was configurable use the 120 s default.
    visionCallTimeoutSeconds:
      value.visionCallTimeoutSeconds === undefined
        ? DEFAULT_SETTINGS.visionCallTimeoutSeconds
        : readInteger(
            value.visionCallTimeoutSeconds,
            'visionCallTimeoutSeconds',
            VISION_CALL_TIMEOUT_MIN_SECONDS,
            VISION_CALL_TIMEOUT_MAX_SECONDS,
          ),
    modelPool,
    exportDir: readOptionalAbsolutePath(value.exportDir, 'exportDir'),
    lastImportPath: readOptionalAbsolutePath(value.lastImportPath, 'lastImportPath'),
    allowRoots: readAllowRoots(value.allowRoots),
    recentExports: readRecentExports(value.recentExports),
  };
}

/**
 * Apply a partial patch to the current settings, validating the merged result.
 *
 * An old writer that patches `model` and/or `visionConcurrency` instead of
 * `modelPool` still works: the patch is materialized as a one-row model pool
 * (or an empty pool when `model` is null), which is exactly the legacy
 * single-model behavior.
 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) throw new SettingsError('settings patch must be a JSON object');
  rejectUnknown(patch, SETTINGS_FIELDS, 'settings patch');
  const merged: Record<string, unknown> = {
    model: 'model' in patch ? patch.model : current.model,
    dataDirLimitGb: 'dataDirLimitGb' in patch ? patch.dataDirLimitGb : current.dataDirLimitGb,
    budgetPerTask: 'budgetPerTask' in patch ? patch.budgetPerTask : current.budgetPerTask,
    frameIntervalSeconds:
      'frameIntervalSeconds' in patch ? patch.frameIntervalSeconds : current.frameIntervalSeconds,
    visionConcurrency: 'visionConcurrency' in patch ? patch.visionConcurrency : current.visionConcurrency,
    objectsPerCall: 'objectsPerCall' in patch ? patch.objectsPerCall : current.objectsPerCall,
    visionCallTimeoutSeconds:
      'visionCallTimeoutSeconds' in patch ? patch.visionCallTimeoutSeconds : current.visionCallTimeoutSeconds,
    exportDir: 'exportDir' in patch ? patch.exportDir : current.exportDir,
    lastImportPath: 'lastImportPath' in patch ? patch.lastImportPath : current.lastImportPath,
    allowRoots: 'allowRoots' in patch ? patch.allowRoots : current.allowRoots,
    recentExports: 'recentExports' in patch ? patch.recentExports : current.recentExports,
  };
  if ('modelPool' in patch) {
    merged.modelPool = patch.modelPool;
  } else if (!('model' in patch) && !('visionConcurrency' in patch)) {
    merged.modelPool = current.modelPool;
  } else if (!('model' in patch) && current.model === null) {
    // A legacy concurrency-only write against a pool-managed configuration:
    // keep the first row's model so the write can still round-trip as one row.
    const first = current.modelPool[0];
    if (first !== undefined) merged.model = { provider: first.provider, model: first.model };
  }
  // In the remaining legacy case no `modelPool` key is set, so parseSettings
  // migrates the merged single model slot into a one-row pool.
  return parseSettings(merged);
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
