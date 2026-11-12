import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import { exportTask } from '../src/export.js';
import { ingestPaths } from '../src/ingest.js';
import type { MediaClient } from '../src/media.js';
import { controlTask, Pipeline } from '../src/pipeline.js';
import { retryTaskFailures } from '../src/retry.js';
import { SettingsStore } from '../src/settings.js';
import type { VisionClient, VisionResult } from '../src/vision.js';
import { makeTempDir, writeFixtureFile } from './helpers.js';
import { seedExportTask } from './export-helpers.js';

// Fixtures live under the OS temp dir; disk capacity is not what these tests cover.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

const AT = '2026-01-01T00:00:00.000Z';

interface SeedOptions {
  taskId?: string;
  itemState?: string;
  frameState?: string;
  framePath?: string | null;
  budgetPerTask?: number;
  callOks?: number[];
}

function insertTarget(db: LocalFramesDatabase, targetId = 'tgt'): void {
  db.raw
    .prepare(
      'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    )
    .run(targetId, 'object-a', '{}', '一个画面中的物体。', AT, AT);
}

function insertTask(db: LocalFramesDatabase, taskId: string, budgetPerTask = 5): void {
  db.raw
    .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      taskId,
      JSON.stringify({
        targetIds: ['tgt'],
        frameIntervalSeconds: 2,
        budgetPerTask,
        model: { provider: 'example', model: 'vision' },
      }),
      '{}',
      'RUNNING',
      AT,
      AT,
    );
}

function seedTask(db: LocalFramesDatabase, options: SeedOptions = {}): { taskId: string; frameId: string } {
  const taskId = options.taskId ?? 'task';
  const frameId = 'frame-old';
  insertTarget(db);
  insertTask(db, taskId, options.budgetPerTask ?? 5);
  db.raw
    .prepare(
      `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 10, 'video.mp4', '{"duration":2}', ?, ?, ?)`,
    )
    .run('item', taskId, '/tmp/video.mp4', 'a'.repeat(64), options.itemState ?? 'PROBED', AT, AT);
  db.raw
    .prepare(
      `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, error, created_at, updated_at)
       VALUES (?, 'item', 0, ?, NULL, ?, '模型调用失败（累计 5 次）', ?, ?)`,
    )
    .run(frameId, options.framePath === undefined ? null : options.framePath, options.frameState ?? 'FAILED', AT, AT);
  const oks = options.callOks ?? [1, 0, 0];
  oks.forEach((ok, index) => {
    db.raw
      .prepare(
        'INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, NULL, ?)',
      )
      .run(`call-old-${index}`, taskId, frameId, 'example/vision', ok, AT);
  });
  return { taskId, frameId };
}

function fakeMedia(): MediaClient {
  return {
    probeDuration: async () => ({ ok: true, duration: 2 }),
    extractFrame: async (_file, _seconds, dest) => {
      writeFixtureFile(dest, 'jpeg-bytes');
      return { ok: true };
    },
    decodeGray: async () => ({ ok: true, raster: { width: 32, height: 32, pixels: new Uint8Array(32 * 32) } }),
    shrinkJpeg: async () => ({ ok: true }),
  };
}

function qualified(name: string): VisionResult {
  return {
    ok: true,
    text: JSON.stringify({
      objects: [{ name, verdict: 'PRESENT', visibility: 'CLEAR', confidence: 0.9, reason: '看清了' }],
    }),
    tokens: 4,
    ms: 1,
  };
}

function successVision(): VisionClient {
  return {
    available: () => true,
    listImageModels: async () => [],
    judge: async (input) => qualified(/"name":"([^"]+)"/u.exec(input.prompt)?.[1] ?? 'object-a'),
  };
}

function failingVision(state: { calls: number }): VisionClient {
  return {
    available: () => true,
    listImageModels: async () => [],
    judge: async () => {
      state.calls += 1;
      return { ok: false, kind: 'retryable', message: 'HTTP 503', retryAfterMs: 1 };
    },
  };
}

function makePipeline(
  db: LocalFramesDatabase,
  settings: SettingsStore,
  dataDir: string,
  vision: VisionClient,
  media: MediaClient,
): Pipeline {
  return new Pipeline({ db, settings, dataDir, media, vision, sleep: async () => undefined, minFreeGb: 0 });
}

function taskRow(db: LocalFramesDatabase, taskId: string): { status?: string; progress_json?: string } | undefined {
  return db.raw.prepare('SELECT status, progress_json FROM tasks WHERE task_id = ?').get(taskId) as
    | { status?: string; progress_json?: string }
    | undefined;
}

function callCount(db: LocalFramesDatabase, taskId: string): number {
  const row = db.raw.prepare('SELECT COUNT(*) AS count FROM calls WHERE task_id = ?').get(taskId) as { count?: number };
  return row.count ?? 0;
}

function callCountForFrame(db: LocalFramesDatabase, frameId: string): number {
  const row = db.raw.prepare('SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?').get(frameId) as { count?: number };
  return row.count ?? 0;
}

const V1_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE targets (
  target_id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases_json TEXT NOT NULL, definition TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, progress_json TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE items (
  item_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
  local_path TEXT NOT NULL, file_sha256 TEXT NOT NULL, file_bytes INTEGER NOT NULL,
  title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', license_raw TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'UNKNOWN', region_evidence TEXT NOT NULL DEFAULT '',
  probe_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (task_id, file_sha256)
);
CREATE TABLE frames (
  frame_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(item_id),
  t_ms INTEGER NOT NULL, path TEXT, width INTEGER, height INTEGER, dhash TEXT,
  duplicate_of TEXT, judge_json TEXT, state TEXT NOT NULL, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (item_id, t_ms)
);
CREATE TABLE labels (
  frame_id TEXT NOT NULL REFERENCES frames(frame_id), target_id TEXT NOT NULL REFERENCES targets(target_id),
  verdict TEXT NOT NULL, visibility TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL,
  outcome TEXT NOT NULL, call_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (frame_id, target_id)
);
CREATE TABLE calls (
  call_id TEXT PRIMARY KEY, frame_id TEXT NOT NULL REFERENCES frames(frame_id),
  model TEXT NOT NULL, ms INTEGER NOT NULL, tokens INTEGER, ok INTEGER NOT NULL,
  error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_calls_frame ON calls(frame_id);
CREATE INDEX idx_calls_ok ON calls(ok);
`;

describe('issue #14: call history drives budget and statistics', () => {
  it('keeps the three spent calls across a manual retry and pauses at the five-call budget', async () => {
    const dataDir = makeTempDir('lf-issue14-budget-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, visionConcurrency: 1, budgetPerTask: 5 });
    seedTask(db, { callOks: [1, 0, 0] });
    const visionState = { calls: 0 };
    const vision = failingVision(visionState);
    const media = fakeMedia();
    try {
      expect(retryTaskFailures(db, dataDir, 'task', { frameIds: ['frame-old'] }).frames_retried).toEqual(['frame-old']);
      expect(callCount(db, 'task')).toBe(3);
      expect(callCountForFrame(db, 'frame-old')).toBe(3);

      await makePipeline(db, settings, dataDir, vision, media).runUntilIdle();
      let task = taskRow(db, 'task');
      expect(task?.status).toBe('PAUSED');
      expect(task?.progress_json).toContain('BUDGET');
      expect(visionState.calls).toBe(2);
      expect(callCount(db, 'task')).toBe(5);
      expect(callCountForFrame(db, 'frame-old')).toBe(3);

      // A fresh process reads the same persisted count and cannot spend a sixth call.
      await makePipeline(db, settings, dataDir, vision, media).runUntilIdle();
      task = taskRow(db, 'task');
      expect(task?.status).toBe('PAUSED');
      expect(visionState.calls).toBe(2);
      expect(callCount(db, 'task')).toBe(5);
    } finally {
      db.close();
    }
  });

  it('gives the frame extracted after a manual retry a fresh five-attempt batch', async () => {
    const dataDir = makeTempDir('lf-issue14-batch-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, visionConcurrency: 1, budgetPerTask: 100 });
    seedTask(db, { callOks: [0, 0, 0, 0, 0] });
    const visionState = { calls: 0 };
    try {
      expect(callCountForFrame(db, 'frame-old')).toBe(5);
      retryTaskFailures(db, dataDir, 'task', { frameIds: ['frame-old'] });
      expect(callCount(db, 'task')).toBe(5);

      await makePipeline(db, settings, dataDir, failingVision(visionState), fakeMedia()).runUntilIdle();
      const frames = db.raw.prepare("SELECT frame_id, state, error FROM frames WHERE item_id = 'item'").all() as Array<{
        frame_id: string;
        state: string;
        error: string | null;
      }>;
      expect(frames).toHaveLength(1);
      expect(frames[0]?.frame_id).not.toBe('frame-old');
      expect(frames[0]?.state).toBe('FAILED');
      expect(frames[0]?.error).toContain('累计 5 次');
      expect(visionState.calls).toBe(5);
      expect(callCountForFrame(db, frames[0]!.frame_id)).toBe(5);
      expect(callCountForFrame(db, 'frame-old')).toBe(5);
      expect(callCount(db, 'task')).toBe(10);
    } finally {
      db.close();
    }
  });

  it('keeps calls and export statistics across a forced rerun', async () => {
    const dataDir = makeTempDir('lf-issue14-rerun-');
    const root = makeTempDir('lf-issue14-videos-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({
      allowRoots: [root],
      model: { provider: 'example', model: 'vision' },
      frameIntervalSeconds: 2,
      visionConcurrency: 1,
      budgetPerTask: 100,
    });
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'original-video');
    insertTarget(db);
    insertTask(db, 'task', 100);
    try {
      const first = await ingestPaths(db, 'task', dataDir, [root], [{ path: file, recursive: false }]);
      expect(first.added).toHaveLength(1);
      await makePipeline(db, settings, dataDir, successVision(), fakeMedia()).runUntilIdle();
      const callsBefore = db.raw.prepare('SELECT call_id, ok FROM calls WHERE task_id = ? ORDER BY call_id').all('task') as Array<{
        call_id: string;
        ok: number;
      }>;
      expect(callsBefore.length).toBeGreaterThan(0);

      // Reopen the finished task for the explicit force rerun.
      db.raw.prepare("UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE task_id = 'task'").run(AT);
      const forced = await ingestPaths(db, 'task', dataDir, [root], [{ path: file, recursive: false }], { force: true });
      expect(forced.rerun).toHaveLength(1);
      expect(callCount(db, 'task')).toBe(callsBefore.length);
      const kept = db.raw
        .prepare(`SELECT COUNT(*) AS count FROM calls WHERE task_id = 'task' AND call_id IN (${callsBefore.map(() => '?').join(',')})`)
        .get(...callsBefore.map((call) => call.call_id)) as { count?: number };
      expect(kept.count).toBe(callsBefore.length);

      await makePipeline(db, settings, dataDir, successVision(), fakeMedia()).runUntilIdle();
      expect(taskRow(db, 'task')?.status).toBe('DONE');
      const total = callCount(db, 'task');
      expect(total).toBeGreaterThan(callsBefore.length);

      const exported = exportTask(db, dataDir, 'task');
      expect(exported.stats.model_calls).toBe(total);
      expect(exported.stats.model_calls_ok).toBe(
        (db.raw.prepare('SELECT COUNT(*) AS count FROM calls WHERE task_id = ? AND ok = 1').get('task') as { count?: number })
          .count,
      );
    } finally {
      db.close();
    }
  });

  it('counts the replaced batch after a manual retry in the export statistics', async () => {
    const dataDir = makeTempDir('lf-issue14-export-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const extraPath = writeFixtureFile(join(dataDir, 'frames', 'extra.jpg'), 'extra');
      db.raw
        .prepare(
          `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, error, created_at, updated_at)
           VALUES ('frame-extra', ?, 5000, ?, NULL, 'FAILED', '模型调用失败（累计 5 次）', ?, ?)`,
        )
        .run(`item-${seeded.taskId}`, extraPath, AT, AT);
      db.raw
        .prepare(
          'INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, NULL, ?)',
        )
        .run('call-extra-ok', seeded.taskId, 'frame-extra', 'example/vision', 1, AT);
      db.raw
        .prepare(
          'INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, NULL, ?)',
        )
        .run('call-extra-fail', seeded.taskId, 'frame-extra', 'example/vision', 0, AT);

      retryTaskFailures(db, dataDir, seeded.taskId, { frameIds: ['frame-extra'] });
      expect(callCount(db, seeded.taskId)).toBe(6);

      const exported = exportTask(db, dataDir, seeded.taskId);
      expect(exported.stats.model_calls).toBe(6);
      expect(exported.stats.model_calls_ok).toBe(5);
      expect(exported.images).toBe(3);
    } finally {
      db.close();
    }
  });

  it('migrates a version-1 database without losing calls, budget or statistics', async () => {
    const dataDir = makeTempDir('lf-issue14-migrate-');
    const framePath = writeFixtureFile(join(dataDir, 'frames', 'frame-v1.jpg'), 'jpeg-bytes');
    const legacy = new DatabaseSync(join(dataDir, 'db.sqlite'));
    legacy.exec('PRAGMA journal_mode = WAL;');
    legacy.exec(V1_SCHEMA);
    legacy
      .prepare('INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run('tgt', 'object-a', '{}', '一个画面中的物体。', AT, AT);
    legacy
      .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task-v1',
        JSON.stringify({
          targetIds: ['tgt'],
          frameIntervalSeconds: 2,
          budgetPerTask: 1,
          model: { provider: 'example', model: 'vision' },
        }),
        '{}',
        'RUNNING',
        AT,
        AT,
      );
    legacy
      .prepare(
        `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 10, 'legacy.mp4', '{"duration":2}', 'FRAMED', ?, ?)`,
      )
      .run('item-v1', 'task-v1', '/tmp/legacy.mp4', 'b'.repeat(64), AT, AT);
    legacy
      .prepare(
        `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
         VALUES ('frame-v1', 'item-v1', 0, ?, '0000000000000000', 'PENDING', ?, ?)`,
      )
      .run(framePath, AT, AT);
    legacy
      .prepare(
        'INSERT INTO calls (call_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, 1, 1, 1, NULL, ?)',
      )
      .run('call-v1', 'frame-v1', 'example/vision', AT);
    legacy.exec('PRAGMA user_version = 1;');
    legacy.close();

    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, visionConcurrency: 1, budgetPerTask: 1 });
    try {
      expect((db.raw.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version).toBe(2);
      expect((db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }).integrity_check).toBe('ok');
      expect(db.raw.prepare("SELECT task_id, frame_id, ok FROM calls WHERE call_id = 'call-v1'").get()).toMatchObject({
        task_id: 'task-v1',
        frame_id: 'frame-v1',
        ok: 1,
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM frames WHERE frame_id = 'frame-v1'").get()).toMatchObject({
        count: 1,
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM items WHERE item_id = 'item-v1'").get()).toMatchObject({
        count: 1,
      });

      // The migrated call already spends the one-call budget: no new call is made.
      await makePipeline(db, settings, dataDir, successVision(), fakeMedia()).runUntilIdle();
      expect(taskRow(db, 'task-v1')?.status).toBe('PAUSED');
      expect(taskRow(db, 'task-v1')?.progress_json).toContain('BUDGET');
      expect(callCount(db, 'task-v1')).toBe(1);

      settings.update({ budgetPerTask: 2 });
      expect(controlTask(db, dataDir, 'task-v1', 'resume').ok).toBe(true);
      await makePipeline(db, settings, dataDir, successVision(), fakeMedia()).runUntilIdle();
      expect(taskRow(db, 'task-v1')?.status).toBe('DONE');
      expect(callCount(db, 'task-v1')).toBe(2);

      const exported = exportTask(db, dataDir, 'task-v1');
      expect(exported.stats.model_calls).toBe(2);
      expect(exported.stats.model_calls_ok).toBe(2);
    } finally {
      db.close();
    }
  });

  it('leaves no orphan calls after a task is deleted', () => {
    const dataDir = makeTempDir('lf-issue14-delete-');
    const db = openDatabase(dataDir);
    try {
      seedTask(db);
      expect(callCount(db, 'task')).toBe(3);
      db.raw.exec("DELETE FROM frames WHERE item_id = 'item';");
      db.raw.exec("DELETE FROM items WHERE task_id = 'task';");
      db.raw.exec("DELETE FROM tasks WHERE task_id = 'task';");
      expect((db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count?: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });
});
