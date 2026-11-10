import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listUserTables, openDatabase, SCHEMA_VERSION } from '../src/db.js';
import { makeTempDir } from './helpers.js';

const EXPECTED_TABLES = ['calls', 'frames', 'items', 'labels', 'settings', 'targets', 'tasks'];

describe('database schema', () => {
  it('creates exactly the seven specification tables', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir);
    try {
      expect(listUserTables(db.raw)).toEqual(EXPECTED_TABLES);
      const version = db.raw.prepare('PRAGMA user_version').get() as { user_version?: number };
      expect(version.user_version).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(1);
    } finally {
      db.close();
    }
  });

  it('reopens an existing database without recreating tables', () => {
    const dir = makeTempDir();
    const first = openDatabase(dir);
    first.raw.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('probe', '1');
    first.close();

    const second = openDatabase(dir);
    try {
      expect(listUserTables(second.raw)).toEqual(EXPECTED_TABLES);
      const row = second.raw.prepare('SELECT value_json FROM settings WHERE key = ?').get('probe') as {
        value_json?: string;
      };
      expect(row.value_json).toBe('1');
    } finally {
      second.close();
    }
  });

  it('refuses a database written by a newer plugin', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir);
    db.raw.exec('PRAGMA user_version = 99;');
    db.close();
    expect(() => openDatabase(dir)).toThrow(/newer than this plugin/);
  });

  it('enforces one item per task and file hash', () => {
    const dir = makeTempDir();
    const db = openDatabase(dir);
    try {
      const now = new Date().toISOString();
      db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-1', '{}', '{}', 'RUNNING', now, now);
      const insert = db.raw.prepare(
        'INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      insert.run('item-1', 'task-1', '/tmp/a.mp4', 'abc', 10, 'a.mp4', 'NEW', now, now);
      expect(() => insert.run('item-2', 'task-1', '/tmp/b.mp4', 'abc', 10, 'b.mp4', 'NEW', now, now)).toThrow();
    } finally {
      db.close();
    }
  });

  it('creates the data directory on demand', () => {
    const dir = join(makeTempDir(), 'nested', 'data');
    mkdirSync(join(dir, '..'), { recursive: true });
    const db = openDatabase(dir);
    try {
      expect(db.file).toBe(join(dir, 'db.sqlite'));
    } finally {
      db.close();
    }
  });
});
