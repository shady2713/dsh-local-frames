import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import { ingestPaths, type IngestReport } from '../src/ingest.js';
import type { MediaClient } from '../src/media.js';
import { Pipeline } from '../src/pipeline.js';
import { SettingsStore } from '../src/settings.js';
import { buildStatus } from '../src/status.js';
import { createTools, type ToolDefinition } from '../src/tool.js';
import type { StatusSnapshot, ToolResult } from '../src/types.js';
import { EnvironmentChecker } from '../src/versions.js';
import type { VisionClient } from '../src/vision.js';
import { fakeExec, healthySubprocess, makeTempDir, writeFixtureFile } from './helpers.js';

// Fixtures live under the OS temp dir; disk capacity is not what these tests cover.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function qualified(name: string) {
  return {
    ok: true as const,
    text: JSON.stringify({
      objects: [{ name, verdict: 'PRESENT', visibility: 'CLEAR', confidence: 0.9, reason: '看清了' }],
    }),
    tokens: 4,
    ms: 1,
  };
}

interface Harness {
  dataDir: string;
  root: string;
  db: LocalFramesDatabase;
  settings: SettingsStore;
  pipeline: Pipeline;
  environment: EnvironmentChecker;
  extracts(): number;
  visionCalls(): number;
  status(): Promise<StatusSnapshot>;
  createTask(taskId: string): void;
  ingest(taskId: string, path: string, force?: boolean): Promise<IngestReport>;
}

function setup(): Harness {
  const dataDir = makeTempDir('lf-issue7-data-');
  const root = makeTempDir('lf-issue7-videos-');
  const db = openDatabase(dataDir);
  const settings = new SettingsStore(db);
  settings.update({
    allowRoots: [root],
    model: { provider: 'example', model: 'vision' },
    frameIntervalSeconds: 2,
    visionConcurrency: 1,
  });
  const now = new Date().toISOString();
  db.raw
    .prepare(
      'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    )
    .run('tgt', 'object-a', '{}', '一个画面中的物体。', now, now);

  let extractCount = 0;
  const media: MediaClient = {
    async probeDuration(file) {
      return file.includes('bad')
        ? { ok: false, error: '无法读取' }
        : { ok: true, duration: 5 };
    },
    async extractFrame(_file, _seconds, dest) {
      extractCount += 1;
      writeFixtureFile(dest, `frame-${extractCount}`);
      return { ok: true };
    },
    async decodeGray() {
      return { ok: true, raster: { width: 32, height: 32, pixels: new Uint8Array(32 * 32) } };
    },
    async shrinkJpeg() {
      return { ok: true };
    },
  };
  let visionCallCount = 0;
  const vision: VisionClient = {
    available: () => true,
    listImageModels: async () => [],
    async judge(input) {
      visionCallCount += 1;
      const name = /"name":"([^"]+)"/u.exec(input.prompt)?.[1] ?? 'object-a';
      return qualified(name);
    },
  };
  const pipeline = new Pipeline({
    db,
    settings,
    dataDir,
    media,
    vision,
    sleep: async () => undefined,
    minFreeGb: 0,
    log: () => undefined,
  });
  const environment = new EnvironmentChecker({
    subprocess: healthySubprocess(),
    dataDir,
    nodeVersion: '24.22.1',
    dshVersion: '0.2.1-rc.5',
    freeGb: () => 100,
  });

  return {
    dataDir,
    root,
    db,
    settings,
    pipeline,
    environment,
    extracts: () => extractCount,
    visionCalls: () => visionCallCount,
    status: () =>
      buildStatus({ db, settings, environment, dataDir, freshEnvironment: false, pluginVersion: '0.1.0' }),
    createTask(taskId: string) {
      const createdAt = new Date().toISOString();
      db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          taskId,
          JSON.stringify({
            targetIds: ['tgt'],
            frameIntervalSeconds: 2,
            budgetPerTask: 3000,
            model: { provider: 'example', model: 'vision' },
          }),
          '{}',
          'RUNNING',
          createdAt,
          createdAt,
        );
    },
    ingest(taskId: string, path: string, force = false) {
      return ingestPaths(db, taskId, dataDir, [root], [{ path, recursive: false }], { force });
    },
  };
}

function scalar(db: LocalFramesDatabase, sql: string, ...params: string[]): number {
  const row = db.raw.prepare(sql).get(...params) as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

function taskStatus(db: LocalFramesDatabase, taskId: string): string {
  const row = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status?: string } | undefined;
  return row?.status ?? '';
}

function framesFor(db: LocalFramesDatabase, taskId: string): number {
  return scalar(
    db,
    'SELECT COUNT(*) AS count FROM frames WHERE item_id IN (SELECT item_id FROM items WHERE task_id = ?)',
    taskId,
  );
}

function callsFor(db: LocalFramesDatabase, taskId: string): number {
  return scalar(db, 'SELECT COUNT(*) AS count FROM calls WHERE task_id = ?', taskId);
}

describe('issue #7: stable multi-video order and progress order', () => {
  it('imports a folder in lexicographic order and exposes the processing order with 1-based positions', async () => {
    const h = setup();
    try {
      // Created out of order on purpose: the directory scan must still be stable.
      writeFixtureFile(join(h.root, 'c.mp4'), 'bytes-c');
      writeFixtureFile(join(h.root, 'a.mp4'), 'bytes-a');
      writeFixtureFile(join(h.root, 'b.mp4'), 'bytes-b');
      h.createTask('task-order');
      const report = await ingestPaths(h.db, 'task-order', h.dataDir, [h.root], [{ path: h.root, recursive: true }]);
      expect(report.added).toHaveLength(3);
      const rows = h.db.raw
        .prepare('SELECT title FROM items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all('task-order') as Array<{ title: string }>;
      expect(rows.map((row) => row.title)).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);

      const before = await h.status();
      expect(before.items.map((item) => item.title)).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
      expect(before.items.map((item) => item.position)).toEqual([1, 2, 3]);

      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-order')).toBe('DONE');
      const after = await h.status();
      expect(after.items.map((item) => item.position)).toEqual([1, 2, 3]);
      expect(after.items.every((item) => item.state === 'DONE')).toBe(true);
    } finally {
      h.db.close();
    }
  });

  it('keeps the submitted order for an explicit batch of file paths', async () => {
    const h = setup();
    try {
      const first = writeFixtureFile(join(h.root, 'z.mp4'), 'bytes-z');
      const second = writeFixtureFile(join(h.root, 'm.mp4'), 'bytes-m');
      h.createTask('task-batch');
      const report = await ingestPaths(h.db, 'task-batch', h.dataDir, [h.root], [
        { path: first, recursive: false },
        { path: second, recursive: false },
      ]);
      expect(report.added).toHaveLength(2);
      const snapshot = await h.status();
      expect(snapshot.items.map((item) => item.title)).toEqual(['z.mp4', 'm.mp4']);
      expect(snapshot.items.map((item) => item.position)).toEqual([1, 2]);
    } finally {
      h.db.close();
    }
  });
});

describe('issue #7: task ends once only failures or skips remain', () => {
  it('finishes the task when the only remaining rows are recorded failures', async () => {
    const h = setup();
    try {
      const good = writeFixtureFile(join(h.root, 'good.mp4'), 'good-bytes');
      const bad = writeFixtureFile(join(h.root, 'bad.mp4'), 'bad-bytes');
      h.createTask('task-fail');
      await h.ingest('task-fail', good);
      await h.ingest('task-fail', bad);
      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-fail')).toBe('DONE');
      const items = h.db.raw.prepare('SELECT title, state, error_code FROM items WHERE task_id = ? ORDER BY rowid').all('task-fail') as Array<{
        title: string;
        state: string;
        error_code: string | null;
      }>;
      expect(items).toEqual([
        { title: 'good.mp4', state: 'DONE', error_code: null },
        { title: 'bad.mp4', state: 'ERROR', error_code: 'PROBE_FAILED' },
      ]);
      const snapshot = await h.status();
      expect(snapshot.funnel.errors).toBe(1);
    } finally {
      h.db.close();
    }
  });

  it('finishes items whose frames already failed or cannot be processed', async () => {
    const h = setup();
    try {
      h.createTask('task-frame-fail');
      const createdAt = new Date().toISOString();
      h.db.raw
        .prepare(
          `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
           VALUES (?, 'task-frame-fail', ?, ?, 10, ?, '{"duration":5}', 'FRAMED', ?, ?)`,
        )
        .run('item-failed-frame', '/tmp/failed-frame.mp4', 'sha-failed-frame', 'failed-frame.mp4', createdAt, createdAt);
      h.db.raw
        .prepare(
          `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, error, created_at, updated_at)
           VALUES ('frame-failed', 'item-failed-frame', 1250, NULL, NULL, 'FAILED', '取帧失败：测试', ?, ?)`,
        )
        .run(createdAt, createdAt);
      h.db.raw
        .prepare(
          `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
           VALUES (?, 'task-frame-fail', ?, ?, 10, ?, '{"duration":5}', 'FRAMED', ?, ?)`,
        )
        .run('item-null-pending', '/tmp/null-pending.mp4', 'sha-null-pending', 'null-pending.mp4', createdAt, createdAt);
      h.db.raw
        .prepare(
          `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
           VALUES ('frame-null-pending', 'item-null-pending', 3750, NULL, NULL, 'PENDING', ?, ?)`,
        )
        .run(createdAt, createdAt);

      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-frame-fail')).toBe('DONE');
      const states = h.db.raw.prepare("SELECT item_id, state FROM items WHERE task_id = 'task-frame-fail' ORDER BY rowid").all() as Array<{
        item_id: string;
        state: string;
      }>;
      expect(states).toEqual([
        { item_id: 'item-failed-frame', state: 'DONE' },
        { item_id: 'item-null-pending', state: 'DONE' },
      ]);
    } finally {
      h.db.close();
    }
  });

  it('finishes a task whose only item fails, without waiting for a retry', async () => {
    const h = setup();
    try {
      const bad = writeFixtureFile(join(h.root, 'bad-only.mp4'), 'bad-only');
      h.createTask('task-bad-only');
      await h.ingest('task-bad-only', bad);
      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-bad-only')).toBe('DONE');
      expect(framesFor(h.db, 'task-bad-only')).toBe(0);
      expect(callsFor(h.db, 'task-bad-only')).toBe(0);
    } finally {
      h.db.close();
    }
  });
});

describe('issue #7: cross-task skip by SHA-256', () => {
  it('skips a video already framed and labelled by an earlier task without new frames or model calls', async () => {
    const h = setup();
    try {
      const file = writeFixtureFile(join(h.root, 'clip.mp4'), 'clip-bytes');
      const digest = sha256(file);
      h.createTask('task-first');
      const first = await h.ingest('task-first', file);
      expect(first.added).toHaveLength(1);
      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-first')).toBe('DONE');
      expect(framesFor(h.db, 'task-first')).toBeGreaterThan(0);
      expect(callsFor(h.db, 'task-first')).toBeGreaterThan(0);

      const extractsBefore = h.extracts();
      const visionBefore = h.visionCalls();
      h.createTask('task-second');
      const second = await h.ingest('task-second', file);
      expect(second.added).toEqual([]);
      expect(second.skipped).toHaveLength(1);
      expect(second.skipped[0]?.fileSha256).toBe(digest);
      const state = h.db.raw.prepare('SELECT state FROM items WHERE task_id = ?').get('task-second') as { state?: string };
      expect(state.state).toBe('SKIPPED');
      expect(framesFor(h.db, 'task-second')).toBe(0);

      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-second')).toBe('DONE');
      expect(framesFor(h.db, 'task-second')).toBe(0);
      expect(callsFor(h.db, 'task-second')).toBe(0);
      expect(h.extracts()).toBe(extractsBefore);
      expect(h.visionCalls()).toBe(visionBefore);

      const snapshot = await h.status();
      expect(snapshot.task?.task_id).toBe('task-second');
      expect(snapshot.funnel.skipped).toBe(1);
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0]).toMatchObject({ position: 1, state: 'SKIPPED', skipped: true });
      const report = snapshot.task?.progress.report as { skipped?: number } | null | undefined;
      expect(report?.skipped).toBe(1);
      expect(sha256(file)).toBe(digest);
    } finally {
      h.db.close();
    }
  });
});

describe('issue #7: explicit force rerun', () => {
  it('reruns a previously processed video in a new task only when force is set', async () => {
    const h = setup();
    try {
      const file = writeFixtureFile(join(h.root, 'clip.mp4'), 'clip-bytes');
      h.createTask('task-first');
      await h.ingest('task-first', file);
      await h.pipeline.runUntilIdle();
      const firstFrames = framesFor(h.db, 'task-first');
      const firstCalls = callsFor(h.db, 'task-first');

      const extractsBefore = h.extracts();
      const visionBefore = h.visionCalls();
      h.createTask('task-forced');
      const report = await h.ingest('task-forced', file, true);
      expect(report.added).toHaveLength(1);
      expect(report.skipped).toEqual([]);
      const state = h.db.raw.prepare('SELECT state FROM items WHERE task_id = ?').get('task-forced') as { state?: string };
      expect(state.state).toBe('NEW');

      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-forced')).toBe('DONE');
      expect(framesFor(h.db, 'task-forced')).toBeGreaterThan(0);
      expect(callsFor(h.db, 'task-forced')).toBeGreaterThan(0);
      expect(h.extracts()).toBeGreaterThan(extractsBefore);
      expect(h.visionCalls()).toBeGreaterThan(visionBefore);
      expect(framesFor(h.db, 'task-first')).toBe(firstFrames);
      expect(callsFor(h.db, 'task-first')).toBe(firstCalls);
    } finally {
      h.db.close();
    }
  });

  it('does not skip a video that an earlier task recorded as ERROR', async () => {
    const h = setup();
    try {
      const bad = writeFixtureFile(join(h.root, 'bad-prior.mp4'), 'bad-prior');
      h.createTask('task-prior-bad');
      await h.ingest('task-prior-bad', bad);
      await h.pipeline.runUntilIdle();
      const prior = h.db.raw.prepare('SELECT state, error_code FROM items WHERE task_id = ?').get('task-prior-bad') as {
        state?: string;
        error_code?: string | null;
      };
      expect(prior).toMatchObject({ state: 'ERROR', error_code: 'PROBE_FAILED' });

      h.createTask('task-retry-bad');
      const report = await h.ingest('task-retry-bad', bad);
      expect(report.skipped).toEqual([]);
      expect(report.added).toHaveLength(1);
      const state = h.db.raw.prepare('SELECT state FROM items WHERE task_id = ?').get('task-retry-bad') as { state?: string };
      expect(state.state).toBe('NEW');
    } finally {
      h.db.close();
    }
  });

  it('applies default skip and explicit force through the lf_collect_start tool entry point', async () => {
    const h = setup();
    try {
      const file = writeFixtureFile(join(h.root, 'tool.mp4'), 'tool-bytes');
      h.createTask('task-tool-first');
      await h.ingest('task-tool-first', file);
      await h.pipeline.runUntilIdle();

      const tools = createTools({
        db: h.db,
        settings: h.settings,
        dataDir: h.dataDir,
        pipeline: h.pipeline,
        environment: h.environment,
        log: () => undefined,
        buildStatus: () => h.status(),
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const tool = (name: string): ToolDefinition => {
        const found = byName.get(name);
        if (found === undefined) throw new Error(`missing tool ${name}`);
        return found;
      };

      const skipped = (await tool('lf_collect_start').execute({ paths: [file] }, fakeExec())) as ToolResult;
      expect(skipped.status).toBe('OK');
      expect((skipped.data as { skipped?: unknown[] }).skipped).toHaveLength(1);
      const skippedTask = String(skipped.data.task_id);
      await h.pipeline.whenIdle();
      expect(taskStatus(h.db, skippedTask)).toBe('DONE');
      expect(framesFor(h.db, skippedTask)).toBe(0);

      const forced = (await tool('lf_collect_start').execute({ paths: [file], force: true }, fakeExec())) as ToolResult;
      expect(forced.status).toBe('OK');
      expect((forced.data as { added?: unknown[] }).added).toHaveLength(1);
      const forcedTask = String(forced.data.task_id);
      await h.pipeline.whenIdle();
      expect(taskStatus(h.db, forcedTask)).toBe('DONE');
      expect(framesFor(h.db, forcedTask)).toBeGreaterThan(0);
      expect(callsFor(h.db, forcedTask)).toBeGreaterThan(0);
    } finally {
      h.db.close();
    }
  });

  it('resets a skipped item in the same task when force is set', async () => {
    const h = setup();
    try {
      const file = writeFixtureFile(join(h.root, 'clip.mp4'), 'clip-bytes');
      h.createTask('task-first');
      await h.ingest('task-first', file);
      await h.pipeline.runUntilIdle();

      h.createTask('task-rerun');
      const skipped = await h.ingest('task-rerun', file);
      expect(skipped.skipped).toHaveLength(1);
      const forced = await h.ingest('task-rerun', file, true);
      expect(forced.rerun).toHaveLength(1);
      expect(forced.added).toEqual([]);
      expect(forced.skipped).toEqual([]);
      const state = h.db.raw.prepare('SELECT state FROM items WHERE task_id = ?').get('task-rerun') as { state?: string };
      expect(state.state).toBe('NEW');

      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-rerun')).toBe('DONE');
      expect(framesFor(h.db, 'task-rerun')).toBeGreaterThan(0);
      expect(callsFor(h.db, 'task-rerun')).toBeGreaterThan(0);
    } finally {
      h.db.close();
    }
  });
});

describe('issue #7: old database and settings stay readable', () => {
  it('opens a legacy schema-1 database with old settings/progress JSON and applies the skip rule', async () => {
    const h = setup();
    try {
      const file = writeFixtureFile(join(h.root, 'legacy.mp4'), 'legacy-bytes');
      const digest = sha256(file);
      // A settings row written before the newer optional fields existed.
      h.db.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(
        JSON.stringify({
          model: { provider: 'example', model: 'vision' },
          dataDirLimitGb: 50,
          budgetPerTask: 3000,
          frameIntervalSeconds: 2,
          allowRoots: [h.root],
        }),
        'settings',
      );
      const loaded = new SettingsStore(h.db).load();
      expect(loaded.visionConcurrency).toBe(2);
      expect(loaded.exportDir).toBeNull();
      expect(loaded.lastImportPath).toBeNull();
      expect(loaded.recentExports).toEqual([]);

      const now = new Date().toISOString();
      h.db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-legacy', JSON.stringify({ targetIds: ['tgt'], frameIntervalSeconds: 2 }), '{}', 'DONE', now, now);
      h.db.raw
        .prepare(
          `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '{}', 'DONE', ?, ?)`,
        )
        .run('item-legacy', 'task-legacy', file, digest, readFileSync(file).length, 'legacy.mp4', now, now);
      h.db.raw
        .prepare(
          `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
           VALUES (?, ?, 1250, NULL, '0000000000000000', 'JUDGED', ?, ?)`,
        )
        .run('frame-legacy', 'item-legacy', now, now);

      h.createTask('task-new');
      const report = await h.ingest('task-new', file);
      expect(report.skipped).toHaveLength(1);
      await h.pipeline.runUntilIdle();
      expect(taskStatus(h.db, 'task-new')).toBe('DONE');
      const snapshot = await h.status();
      expect(snapshot.funnel.skipped).toBe(1);
    } finally {
      h.db.close();
    }
  });
});
