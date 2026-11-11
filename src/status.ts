import { directorySizeBytes, freeDiskGb } from './disk.js';
import type { LocalFramesDatabase } from './db.js';
import type { SettingsStore } from './settings.js';
import type { EnvironmentChecker } from './versions.js';
import { readProgress } from './progress.js';
import type { StatusSnapshot, TaskRow, TargetAliases } from './types.js';

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseAliases(text: string): TargetAliases {
  const value = parseJsonObject(text);
  const aliases: TargetAliases = {};
  for (const [language, list] of Object.entries(value)) {
    if (Array.isArray(list)) {
      aliases[language] = list.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return aliases;
}

interface CountRow {
  count?: number;
}

function scalar(db: LocalFramesDatabase, sql: string, ...params: string[]): number {
  const row = db.raw.prepare(sql).get(...params) as CountRow | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

function latestTask(db: LocalFramesDatabase): TaskRow | null {
  const row = db.raw
    .prepare('SELECT task_id, spec_json, progress_json, status, created_at, updated_at FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as TaskRow | undefined;
  return row ?? null;
}

function funnelFor(db: LocalFramesDatabase, taskId: string | null): StatusSnapshot['funnel'] {
  if (taskId === null) {
    return {
      imported: 0,
      probed: 0,
      frames: 0,
      duplicatesSkipped: 0,
      skipped: 0,
      judged: 0,
      exportable: 0,
      errors: 0,
    };
  }
  return {
    imported: scalar(db, 'SELECT COUNT(*) AS count FROM items WHERE task_id = ?', taskId),
    probed: scalar(
      db,
      "SELECT COUNT(*) AS count FROM items WHERE task_id = ? AND state IN ('PROBED', 'FRAMED', 'DONE')",
      taskId,
    ),
    frames: scalar(
      db,
      'SELECT COUNT(*) AS count FROM frames WHERE item_id IN (SELECT item_id FROM items WHERE task_id = ?)',
      taskId,
    ),
    duplicatesSkipped: scalar(
      db,
      "SELECT COUNT(*) AS count FROM frames WHERE state = 'DUPLICATE' AND item_id IN (SELECT item_id FROM items WHERE task_id = ?)",
      taskId,
    ),
    skipped: scalar(db, "SELECT COUNT(*) AS count FROM items WHERE task_id = ? AND state = 'SKIPPED'", taskId),
    judged: scalar(
      db,
      "SELECT COUNT(*) AS count FROM frames WHERE state = 'JUDGED' AND item_id IN (SELECT item_id FROM items WHERE task_id = ?)",
      taskId,
    ),
    exportable: scalar(
      db,
      `SELECT COUNT(DISTINCT labels.frame_id) AS count FROM labels
       JOIN frames ON frames.frame_id = labels.frame_id
       WHERE labels.outcome = 'QUALIFIED'
         AND frames.item_id IN (SELECT item_id FROM items WHERE task_id = ?)`,
      taskId,
    ),
    errors: scalar(db, "SELECT COUNT(*) AS count FROM items WHERE task_id = ? AND state = 'ERROR'", taskId),
  };
}

/**
 * Task items in processing order. `created_at` plus `rowid` is the same order
 * the state machine and export use, so the progress page shows the real queue
 * (including videos skipped as previously processed).
 */
function itemsFor(db: LocalFramesDatabase, taskId: string | null): StatusSnapshot['items'] {
  if (taskId === null) return [];
  const rows = db.raw
    .prepare(
      `SELECT item_id, local_path, title, state, error_code FROM items
       WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(taskId) as Array<{
    item_id: string;
    local_path: string;
    title: string;
    state: string;
    error_code: string | null;
  }>;
  return rows.map((row, index) => ({
    position: index + 1,
    item_id: row.item_id,
    local_path: row.local_path,
    title: row.title,
    state: row.state,
    error_code: row.error_code,
    skipped: row.state === 'SKIPPED',
  }));
}

/** Compose the read-only status shared by `lf_status` and the plugin's status route. */
export async function buildStatus(options: {
  db: LocalFramesDatabase;
  settings: SettingsStore;
  environment: EnvironmentChecker;
  dataDir: string;
  /** `lf_status` runs the §15.1 checks on every call. */
  freshEnvironment: boolean;
  pluginVersion: string;
}): Promise<StatusSnapshot> {
  const { db, settings, environment, dataDir } = options;
  const current = settings.load();
  const targetRows = db.raw
    .prepare(
      'SELECT target_id, name, aliases_json, definition, archived, created_at, updated_at FROM targets ORDER BY created_at ASC, rowid ASC',
    )
    .all() as Array<{
    target_id: string;
    name: string;
    aliases_json: string;
    definition: string;
    archived: number;
    created_at: string;
    updated_at: string;
  }>;
  const task = latestTask(db);
  const environmentReport = await environment.check(options.freshEnvironment);

  return {
    plugin: { id: 'local-frames', version: options.pluginVersion },
    settings: current,
    targets: targetRows.map((row) => ({
      target_id: row.target_id,
      name: row.name,
      aliases: parseAliases(row.aliases_json),
      definition: row.definition,
      archived: row.archived !== 0,
    })),
    task:
      task === null
        ? null
        : {
            task_id: task.task_id,
            status: task.status,
            progress: parseJsonObject(task.progress_json),
          },
    funnel: funnelFor(db, task?.task_id ?? null),
    items: itemsFor(db, task?.task_id ?? null),
    errors:
      task === null
        ? []
        : (db.raw
            .prepare(
              "SELECT item_id, local_path, error_code FROM items WHERE task_id = ? AND state = 'ERROR' ORDER BY created_at ASC, rowid ASC",
            )
            .all(task.task_id) as Array<{ item_id: string; local_path: string; error_code: string | null }>),
    pause:
      task === null
        ? null
        : {
            code: readProgress(task.progress_json).pauseCode,
            reason: readProgress(task.progress_json).pauseReason,
          },
    dataDir: {
      path: dataDir,
      usedBytes: directorySizeBytes(dataDir),
      limitGb: current.dataDirLimitGb,
      freeGb: freeDiskGb(dataDir),
    },
    environment: environmentReport,
  };
}
