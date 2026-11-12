import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Bump only together with a migration in {@link migrateCallsToV2}. */
export const SCHEMA_VERSION = 2;

/**
 * Version 2 keeps every model call for a task even after its frame row is
 * replaced by a manual retry or force rerun. `task_id` is the stable owner;
 * `frame_id` is deliberately not a foreign key so dropped frames do not drag
 * historical calls (and their budget/statistics) with them.
 */
const CALLS_SQL = `
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  frame_id TEXT NOT NULL,
  model TEXT NOT NULL,
  ms INTEGER NOT NULL,
  tokens INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);`;

/**
 * The full schema, applied as one script to a new database. Exactly seven
 * tables: settings, targets, tasks, items, frames, labels, calls.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  target_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  definition TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  item_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  local_path TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_bytes INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  license_raw TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'UNKNOWN',
  region_evidence TEXT NOT NULL DEFAULT '',
  probe_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, file_sha256)
);

CREATE TABLE IF NOT EXISTS frames (
  frame_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(item_id),
  t_ms INTEGER NOT NULL,
  path TEXT,
  width INTEGER,
  height INTEGER,
  dhash TEXT,
  duplicate_of TEXT,
  judge_json TEXT,
  state TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (item_id, t_ms)
);

CREATE TABLE IF NOT EXISTS labels (
  frame_id TEXT NOT NULL REFERENCES frames(frame_id),
  target_id TEXT NOT NULL REFERENCES targets(target_id),
  verdict TEXT NOT NULL,
  visibility TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL,
  call_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (frame_id, target_id)
);

${CALLS_SQL}

CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_active_name ON targets(name) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_items_task_state ON items(task_id, state);
CREATE INDEX IF NOT EXISTS idx_items_sha256 ON items(file_sha256);
CREATE INDEX IF NOT EXISTS idx_items_task_path ON items(task_id, local_path);
CREATE INDEX IF NOT EXISTS idx_frames_item_time ON frames(item_id, t_ms);
CREATE INDEX IF NOT EXISTS idx_frames_dhash ON frames(dhash);
CREATE INDEX IF NOT EXISTS idx_frames_duplicate ON frames(duplicate_of);
CREATE INDEX IF NOT EXISTS idx_labels_frame ON labels(frame_id);
CREATE INDEX IF NOT EXISTS idx_calls_task ON calls(task_id);
CREATE INDEX IF NOT EXISTS idx_calls_frame ON calls(frame_id);
CREATE INDEX IF NOT EXISTS idx_calls_ok ON calls(ok);
`;

export interface LocalFramesDatabase {
  readonly raw: DatabaseSync;
  readonly file: string;
  close(): void;
}

function userVersion(raw: DatabaseSync): number {
  const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

/** All user tables, sorted; used by status and tests without touching SQLite internals. */
export function listUserTables(raw: DatabaseSync): string[] {
  const rows = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function countRows(raw: DatabaseSync, table: string): number {
  const row = raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

/**
 * Upgrade a version-1 `calls` table in place: v1 pointed at a frame row and
 * lost its history when retries deleted that frame. v2 owns the call by task,
 * so the same rows keep counting toward the budget and the export statistics.
 *
 * Runs inside the caller's transaction. Rows whose frame/item no longer exist
 * cannot be attributed to a task; the migration refuses (and rolls back) rather
 * than silently dropping history.
 */
function migrateCallsToV2(raw: DatabaseSync): void {
  const before = countRows(raw, 'calls');
  raw.exec('ALTER TABLE calls RENAME TO calls_v1;');
  raw.exec(CALLS_SQL);
  raw.exec(`
    INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, error, created_at)
    SELECT calls_v1.call_id, items.task_id, calls_v1.frame_id, calls_v1.model,
           calls_v1.ms, calls_v1.tokens, calls_v1.ok, calls_v1.error, calls_v1.created_at
    FROM calls_v1
    JOIN frames ON frames.frame_id = calls_v1.frame_id
    JOIN items ON items.item_id = frames.item_id
  `);
  const after = countRows(raw, 'calls');
  if (after !== before) {
    throw new Error(
      `local-frames: calls migration lost history (${before} -> ${after}); database left unchanged`,
    );
  }
  raw.exec('DROP TABLE calls_v1;');
}

/**
 * Open (and on first use create) the plugin database under `dataDir`.
 *
 * The directory is created here so a sandbox profile can point at a temporary
 * directory. A database written by a newer plugin is refused instead of being
 * silently downgraded; the caller keeps the file for backup.
 */
export function openDatabase(dataDir: string): LocalFramesDatabase {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'db.sqlite');
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA journal_mode = WAL;');
    raw.exec('PRAGMA busy_timeout = 5000;');
    raw.exec('PRAGMA foreign_keys = ON;');

    const version = userVersion(raw);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `local-frames: database schema ${version} is newer than this plugin (${SCHEMA_VERSION}); back up and recreate ${file}`,
      );
    }
    if (version < SCHEMA_VERSION) {
      raw.exec('BEGIN IMMEDIATE;');
      try {
        if (version === 1) migrateCallsToV2(raw);
        raw.exec(SCHEMA_SQL);
        raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
        raw.exec('COMMIT;');
      } catch (error) {
        try {
          raw.exec('ROLLBACK;');
        } catch {
          // keep the original failure
        }
        throw error;
      }
    }
  } catch (error) {
    raw.close();
    throw error;
  }

  return {
    raw,
    file,
    close() {
      raw.close();
    },
  };
}
