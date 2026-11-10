import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Bump only together with a migration in {@link SCHEMA_SQL}. */
export const SCHEMA_VERSION = 1;

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

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  frame_id TEXT NOT NULL REFERENCES frames(frame_id),
  model TEXT NOT NULL,
  ms INTEGER NOT NULL,
  tokens INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_active_name ON targets(name) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_items_task_state ON items(task_id, state);
CREATE INDEX IF NOT EXISTS idx_items_sha256 ON items(file_sha256);
CREATE INDEX IF NOT EXISTS idx_items_task_path ON items(task_id, local_path);
CREATE INDEX IF NOT EXISTS idx_frames_item_time ON frames(item_id, t_ms);
CREATE INDEX IF NOT EXISTS idx_frames_dhash ON frames(dhash);
CREATE INDEX IF NOT EXISTS idx_frames_duplicate ON frames(duplicate_of);
CREATE INDEX IF NOT EXISTS idx_labels_frame ON labels(frame_id);
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
