import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import type { MediaClient } from '../src/media.js';
import { Pipeline } from '../src/pipeline.js';
import { createRoutes } from '../src/routes.js';
import { defaultSettings, SettingsStore } from '../src/settings.js';
import type { StatusSnapshot } from '../src/types.js';
import { EnvironmentChecker } from '../src/versions.js';
import type { VisionClient } from '../src/vision.js';
import { readZipEntries, seedExportTask, tableCount } from './export-helpers.js';
import { healthySubprocess, makeTempDir, mockRequest, mockResponse, writeFixtureFile } from './helpers.js';

// Fixtures live under the OS temp dir; disk capacity is not what these tests cover.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

const AT = '2026-01-01T00:00:00.000Z';

function snapshot(): StatusSnapshot {
  return {
    plugin: { id: 'local-frames', version: '0.1.0' },
    settings: defaultSettings(),
    targets: [],
    task: null,
    funnel: { imported: 0, probed: 0, frames: 0, duplicatesSkipped: 0, skipped: 0, judged: 0, exportable: 0, errors: 0 },
    items: [],
    errors: [],
    failedFrames: [],
    pause: null,
    dataDir: { path: '/tmp/local-frames', usedBytes: 0, limitGb: 50, freeGb: 100 },
    environment: { ok: true, checks: [], missing: [], checkedAt: AT },
  };
}

interface Harness {
  dataDir: string;
  db: LocalFramesDatabase;
  settings: SettingsStore;
  routes: ReturnType<typeof createRoutes>;
  kicks(): number;
}

function harness(): Harness {
  const dataDir = makeTempDir('lf-issue4-data-');
  const db = openDatabase(dataDir);
  const settings = new SettingsStore(db);
  const state = { kicks: 0 };
  const pipeline = {
    kick: () => {
      state.kicks += 1;
    },
  } as unknown as Pipeline;
  const routes = createRoutes({
    buildStatus: async () => snapshot(),
    log: () => undefined,
    db,
    settings,
    dataDir,
    pipeline,
  });
  return { dataDir, db, settings, routes, kicks: () => state.kicks };
}

async function getJson(routes: ReturnType<typeof createRoutes>, url: string): Promise<{ status: number; json(): unknown }> {
  const { res, result } = mockResponse();
  await routes(mockRequest({ method: 'GET', url, headers: { host: '127.0.0.1:3080' } }), res);
  return result;
}

async function postJson(
  routes: ReturnType<typeof createRoutes>,
  url: string,
  body: unknown,
): Promise<{ status: number; json(): unknown }> {
  const { res, result } = mockResponse();
  await routes(
    mockRequest({
      method: 'POST',
      url,
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    res,
  );
  return result;
}

function insertTarget(db: LocalFramesDatabase, targetId: string, name: string): void {
  db.raw
    .prepare(
      'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    )
    .run(targetId, name, '{}', `一个画面中的${name}。`, AT, AT);
}

function insertTask(
  db: LocalFramesDatabase,
  taskId: string,
  status: string,
  targetIds: string[],
  createdAt = AT,
  progress: Record<string, unknown> = {},
): void {
  db.raw
    .prepare(
      'INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      taskId,
      JSON.stringify({ targetIds, frameIntervalSeconds: 2, budgetPerTask: 3000, model: { provider: 'example', model: 'vision' } }),
      JSON.stringify(progress),
      status,
      createdAt,
      createdAt,
    );
}

function insertItem(
  db: LocalFramesDatabase,
  options: {
    itemId: string;
    taskId: string;
    state: string;
    probe?: Record<string, unknown>;
    localPath?: string;
    errorCode?: string | null;
    updatedAt?: string;
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, author, license_raw,
                          region, region_evidence, probe_json, state, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, 10, ?, '', '', 'UNKNOWN', '', ?, ?, ?, ?, ?)`,
    )
    .run(
      options.itemId,
      options.taskId,
      options.localPath ?? `/tmp/${options.itemId}.mp4`,
      options.itemId.padEnd(64, '0').slice(0, 64),
      `${options.itemId}.mp4`,
      JSON.stringify(options.probe ?? {}),
      options.state,
      options.errorCode ?? null,
      AT,
      options.updatedAt ?? AT,
    );
}

function insertFrame(
  db: LocalFramesDatabase,
  options: {
    frameId: string;
    itemId: string;
    tMs: number;
    state: string;
    path?: string | null;
    error?: string | null;
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO frames (frame_id, item_id, t_ms, path, width, height, dhash, duplicate_of, judge_json, state, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(options.frameId, options.itemId, options.tMs, options.path ?? null, options.state, options.error ?? null, AT, AT);
}

function insertCall(db: LocalFramesDatabase, taskId: string, frameId: string, callId: string, ok = 1): void {
  db.raw
    .prepare(
      'INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, NULL, ?)',
    )
    .run(callId, taskId, frameId, 'example/vision', ok, AT);
}

function insertLabel(db: LocalFramesDatabase, frameId: string, targetId: string): void {
  db.raw
    .prepare(
      `INSERT INTO labels (frame_id, target_id, verdict, visibility, confidence, reason, outcome, call_id, created_at)
       VALUES (?, ?, 'PRESENT', 'CLEAR', 0.9, '测试', 'QUALIFIED', ?, ?)`,
    )
    .run(frameId, targetId, `call-${frameId}`, AT);
}

describe('client page registration', () => {
  it('registers exactly one page and keeps no archive entry', () => {
    const source = readFileSync(join(process.cwd(), 'client.js'), 'utf8');
    let definition: any;
    const fakeWindow = {
      __ModuleLoader__: {
        load: (value: unknown) => {
          definition = value;
        },
      },
    };
    const fakeDocument = {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: () => undefined },
    };
    new Function('window', 'document', source)(fakeWindow, fakeDocument);
    const registrations: Array<Record<string, unknown>> = [];
    const fakeReact = { createElement: () => null };
    const module = definition.factory((name: string) => {
      if (name === 'react') return fakeReact;
      throw new Error(`unexpected module ${name}`);
    });
    module.apply({
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (options: Record<string, unknown>) => {
          registrations.push(options);
          return () => undefined;
        },
      },
      effect: () => undefined,
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ name: 'settings.section', id: 'local-frames', label: '本地视频帧' });
    expect(source).not.toContain('归档');
    expect(source).not.toContain('/targets/archive');
    expect(source).not.toContain('local-frames-settings');
    expect(source).not.toContain('local-frames-progress');
    expect(source).not.toContain('本地视频帧 · 设置');
    expect(source).not.toContain('本地视频帧 · 进度');
  });
});

describe('task list route', () => {
  it('returns every task with funnel, failure count and selected objects', async () => {
    const h = harness();
    try {
      const seeded = seedExportTask(h.db, h.dataDir);
      insertTask(h.db, 'task-newer', 'DONE', [seeded.targetA], '2026-01-02T00:00:00.000Z');
      insertItem(h.db, { itemId: 'item-newer', taskId: 'task-newer', state: 'ERROR', errorCode: 'PROBE_FAILED' });
      insertFrame(h.db, {
        frameId: 'frame-newer',
        itemId: 'item-newer',
        tMs: 0,
        state: 'FAILED',
        error: '取帧失败：测试',
      });

      const result = await getJson(h.routes, '/api/local-frames/tasks');
      expect(result.status).toBe(200);
      const tasks = (result.json() as { data: { tasks: Array<any> } }).data.tasks;
      expect(tasks.map((task) => task.task_id)).toEqual(['task-newer', seeded.taskId]);

      const newer = tasks[0]!;
      expect(newer).toMatchObject({
        status: 'DONE',
        created_at: '2026-01-02T00:00:00.000Z',
        failedFrames: 1,
        targets: [{ target_id: seeded.targetA, name: 'object-a' }],
      });
      expect(newer.funnel).toMatchObject({
        imported: 1,
        frames: 1,
        judged: 0,
        exportable: 0,
        errors: 1,
      });

      const seededRow = tasks[1]!;
      expect(seededRow.funnel).toMatchObject({
        imported: 1,
        frames: 4,
        judged: 4,
        exportable: 3,
        errors: 0,
      });
      expect(seededRow.failedFrames).toBe(0);
      expect(seededRow.targets).toEqual([
        { target_id: seeded.targetA, name: 'object-a' },
        { target_id: seeded.targetB, name: 'object-b' },
      ]);
    } finally {
      h.db.close();
    }
  });

  it('exports a completed task listed by the task list without adding frames or calls', async () => {
    const h = harness();
    try {
      const seeded = seedExportTask(h.db, h.dataDir);
      const before = {
        frames: tableCount(h.db, 'frames'),
        calls: tableCount(h.db, 'calls'),
        labels: tableCount(h.db, 'labels'),
      };
      const directoryExport = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        targetIds: [seeded.targetB],
        byObject: true,
      });
      expect(directoryExport.status).toBe(200);
      const directoryData = (
        directoryExport.json() as {
          data: { images: number; targetNames: string[]; directory: string; recentExports: unknown[] };
        }
      ).data;
      expect(directoryData.images).toBe(2);
      expect(directoryData.targetNames).toEqual(['object-b']);
      expect(directoryData.recentExports).toHaveLength(1);

      const zipExport = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        targetIds: [seeded.targetB],
        zip: true,
        byObject: true,
      });
      expect(zipExport.status).toBe(200);
      const zipData = (zipExport.json() as { data: { images: number; directory: string; recentExports: unknown[] } }).data;
      expect(zipData.images).toBe(2);
      expect(zipData.recentExports).toHaveLength(2);
      const entries = [...readZipEntries(zipData.directory).keys()];
      expect(entries.some((entry) => entry.startsWith('images/object-b/'))).toBe(true);
      expect(entries).toContain('stats.json');

      expect(tableCount(h.db, 'frames')).toBe(before.frames);
      expect(tableCount(h.db, 'calls')).toBe(before.calls);
      expect(tableCount(h.db, 'labels')).toBe(before.labels);
    } finally {
      h.db.close();
    }
  });
});

describe('settings from #3, #6 and #7 stay readable and writable', () => {
  it('round-trips exportDir, frame interval, concurrency and the allowlist', async () => {
    const h = harness();
    try {
      const exportDir = makeTempDir('lf-issue4-export-');
      const root = makeTempDir('lf-issue4-root-');
      const saved = await postJson(h.routes, '/api/local-frames/settings', {
        exportDir,
        frameIntervalSeconds: 7,
        visionConcurrency: 5,
        allowRoots: [root],
      });
      expect(saved.status).toBe(200);
      const data = (saved.json() as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        exportDir,
        frameIntervalSeconds: 7,
        visionConcurrency: 5,
        allowRoots: [root],
      });
      const reloaded = new SettingsStore(h.db).load();
      expect(reloaded).toMatchObject({
        exportDir,
        frameIntervalSeconds: 7,
        visionConcurrency: 5,
        allowRoots: [root],
      });
      const rejected = await postJson(h.routes, '/api/local-frames/settings', { frameIntervalSeconds: 3601 });
      expect(rejected.status).toBe(400);
      expect(new SettingsStore(h.db).load().frameIntervalSeconds).toBe(7);
    } finally {
      h.db.close();
    }
  });
});

describe('manual retry route', () => {
  function retryTask(h: Harness): {
    itemA: string;
    itemB: string;
    itemDone: string;
    frameA: string;
    frameB: string;
    keptFrame: string;
  } {
    const targetId = 'target-retry';
    insertTarget(h.db, targetId, 'object-a');
    insertTask(h.db, 'task-retry', 'DONE', [targetId]);
    insertItem(h.db, { itemId: 'item-a', taskId: 'task-retry', state: 'ERROR', probe: { duration: 5 }, errorCode: 'FRAME_FAILED' });
    insertItem(h.db, { itemId: 'item-b', taskId: 'task-retry', state: 'ERROR', errorCode: 'PROBE_FAILED' });
    insertItem(h.db, { itemId: 'item-done', taskId: 'task-retry', state: 'DONE', probe: { duration: 5 } });
    insertFrame(h.db, { frameId: 'frame-a', itemId: 'item-a', tMs: 0, state: 'FAILED', error: '取帧失败：测试' });
    insertFrame(h.db, { frameId: 'frame-b', itemId: 'item-b', tMs: 0, state: 'FAILED', error: '模型输出不合法：测试' });
    insertCall(h.db, 'task-retry', 'frame-b', 'call-b', 0);
    insertFrame(h.db, { frameId: 'frame-kept', itemId: 'item-done', tMs: 0, state: 'JUDGED' });
    insertCall(h.db, 'task-retry', 'frame-kept', 'call-kept');
    insertLabel(h.db, 'frame-kept', targetId);
    return {
      itemA: 'item-a',
      itemB: 'item-b',
      itemDone: 'item-done',
      frameA: 'frame-a',
      frameB: 'frame-b',
      keptFrame: 'frame-kept',
    };
  }

  it('retries one failed video, one failed frame, and all failures in a batch', async () => {
    const h = harness();
    try {
      const ids = retryTask(h);
      const singleItem = await postJson(h.routes, '/api/local-frames/retry', { taskId: 'task-retry', itemIds: [ids.itemA] });
      expect(singleItem.status).toBe(200);
      expect((singleItem.json() as { data: { items_retried: string[] } }).data.items_retried).toEqual([ids.itemA]);
      expect(h.db.raw.prepare('SELECT state, error_code FROM items WHERE item_id = ?').get(ids.itemA)).toMatchObject({
        state: 'PROBED',
        error_code: null,
      });
      expect(h.db.raw.prepare('SELECT 1 FROM frames WHERE frame_id = ?').get(ids.frameA)).toBeUndefined();
      expect(h.db.raw.prepare('SELECT 1 FROM frames WHERE frame_id = ?').get(ids.frameB)).toBeDefined();
      expect(h.db.raw.prepare('SELECT 1 FROM frames WHERE frame_id = ?').get(ids.keptFrame)).toBeDefined();
      expect(h.db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-retry')).toMatchObject({
        status: 'RUNNING',
      });
      expect(h.kicks()).toBe(1);

      const singleFrame = await postJson(h.routes, '/api/local-frames/retry', { taskId: 'task-retry', frameIds: [ids.frameB] });
      expect(singleFrame.status).toBe(200);
      expect((singleFrame.json() as { data: { frames_retried: string[] } }).data.frames_retried).toEqual([ids.frameB]);
      expect(h.db.raw.prepare('SELECT state FROM items WHERE item_id = ?').get(ids.itemB)).toMatchObject({ state: 'NEW' });
      expect(h.db.raw.prepare('SELECT 1 FROM frames WHERE frame_id = ?').get(ids.frameB)).toBeUndefined();
      // Calls are history: retrying the frame keeps its spent budget/call stats.
      expect(h.db.raw.prepare('SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?').get(ids.frameB)).toMatchObject({
        count: 1,
      });
      expect(h.db.raw.prepare('SELECT COUNT(*) AS count FROM labels WHERE frame_id = ?').get(ids.keptFrame)).toMatchObject({
        count: 1,
      });

      h.db.raw.prepare("UPDATE tasks SET status = 'DONE' WHERE task_id = 'task-retry'").run();
      insertTask(h.db, 'task-batch', 'DONE', ['target-retry'], '2026-01-03T00:00:00.000Z');
      insertItem(h.db, { itemId: 'batch-a', taskId: 'task-batch', state: 'ERROR', probe: { duration: 5 }, errorCode: 'FRAME_FAILED' });
      insertItem(h.db, { itemId: 'batch-b', taskId: 'task-batch', state: 'ERROR', errorCode: 'PROBE_FAILED' });
      insertFrame(h.db, { frameId: 'batch-frame-a', itemId: 'batch-a', tMs: 0, state: 'FAILED', error: '取帧失败：测试' });
      insertFrame(h.db, { frameId: 'batch-frame-b', itemId: 'batch-b', tMs: 0, state: 'FAILED', error: '模型输出不合法：测试' });
      const batch = await postJson(h.routes, '/api/local-frames/retry', { taskId: 'task-batch', all: true });
      expect(batch.status).toBe(200);
      const batchData = (batch.json() as { data: { items_retried: string[]; frames_retried: string[] } }).data;
      expect(batchData.items_retried.sort()).toEqual(['batch-a', 'batch-b']);
      expect(batchData.frames_retried.sort()).toEqual(['batch-frame-a', 'batch-frame-b']);
      expect(h.db.raw.prepare('SELECT state FROM items WHERE item_id = ?').get('batch-a')).toMatchObject({ state: 'PROBED' });
      expect(h.db.raw.prepare('SELECT state FROM items WHERE item_id = ?').get('batch-b')).toMatchObject({ state: 'NEW' });
      expect(h.db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-batch')).toMatchObject({
        status: 'RUNNING',
      });
      expect(h.kicks()).toBe(3);
    } finally {
      h.db.close();
    }
  });

  it('refuses non-retryable pauses and unknown tasks without changing state', async () => {
    const h = harness();
    try {
      insertTarget(h.db, 'target-blocked', 'object-a');
      insertTask(h.db, 'task-blocked', 'PAUSED', ['target-blocked'], AT, {
        pauseCode: 'MODEL_CREDENTIAL',
        pauseReason: '凭据无效',
      });
      insertItem(h.db, { itemId: 'blocked-a', taskId: 'task-blocked', state: 'ERROR', errorCode: 'FRAME_FAILED' });

      const blocked = await postJson(h.routes, '/api/local-frames/retry', {
        taskId: 'task-blocked',
        itemIds: ['blocked-a'],
      });
      expect(blocked.status).toBe(409);
      expect(blocked.json()).toMatchObject({ status: 'ERROR', code: 'NOT_RETRYABLE' });
      expect(String((blocked.json() as { message: string }).message)).toContain('不可重试');
      expect(h.db.raw.prepare('SELECT state FROM items WHERE item_id = ?').get('blocked-a')).toMatchObject({
        state: 'ERROR',
      });
      expect(h.db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-blocked')).toMatchObject({
        status: 'PAUSED',
      });
      expect(h.kicks()).toBe(0);

      const missing = await postJson(h.routes, '/api/local-frames/retry', { taskId: 'nope', all: true });
      expect(missing.status).toBe(404);
      const invalid = await postJson(h.routes, '/api/local-frames/retry', { taskId: 'task-blocked' });
      expect(invalid.status).toBe(400);
    } finally {
      h.db.close();
    }
  });

  it('reprocesses a retried failed video through the state machine', async () => {
    const dataDir = makeTempDir('lf-issue4-retry-data-');
    const root = makeTempDir('lf-issue4-retry-videos-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, allowRoots: [root] });
    insertTarget(db, 'target-live', 'object-a');
    const video = writeFixtureFile(join(root, 'clip.mp4'), 'original-video');
    insertTask(db, 'task-live', 'DONE', ['target-live']);
    insertItem(db, {
      itemId: 'live-item',
      taskId: 'task-live',
      state: 'ERROR',
      probe: { duration: 5 },
      localPath: video,
      errorCode: 'FRAME_FAILED',
    });
    insertFrame(db, { frameId: 'live-failed', itemId: 'live-item', tMs: 0, state: 'FAILED', error: '取帧失败：测试' });

    const media: MediaClient = {
      async probeDuration() {
        return { ok: true, duration: 5 };
      },
      async extractFrame(_file, _seconds, dest) {
        writeFixtureFile(dest, 'frame');
        return { ok: true };
      },
      async decodeGray() {
        return { ok: true, raster: { width: 32, height: 32, pixels: new Uint8Array(32 * 32) } };
      },
      async shrinkJpeg() {
        return { ok: true };
      },
    };
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      async judge(input) {
        const name = /"name":"([^"]+)"/u.exec(input.prompt)?.[1] ?? 'object-a';
        return {
          ok: true,
          text: JSON.stringify({
            objects: [{ name, verdict: 'PRESENT', visibility: 'CLEAR', confidence: 0.9, reason: '看清了' }],
          }),
          tokens: 4,
          ms: 1,
        };
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
    const routes = createRoutes({
      buildStatus: async () => snapshot(),
      log: () => undefined,
      db,
      settings,
      dataDir,
      pipeline,
    });
    try {
      const retried = await postJson(routes, '/api/local-frames/retry', { taskId: 'task-live', itemIds: ['live-item'] });
      expect(retried.status).toBe(200);
      await pipeline.runUntilIdle();
      expect(db.raw.prepare('SELECT state, error_code FROM items WHERE item_id = ?').get('live-item')).toMatchObject({
        state: 'DONE',
        error_code: null,
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM frames WHERE item_id = ? AND state = 'JUDGED'").get('live-item')).toMatchObject({
        count: 1,
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM frames WHERE item_id = ? AND state = 'FAILED'").get('live-item')).toMatchObject({
        count: 0,
      });
      expect(db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get()).toMatchObject({ count: 1 });
      expect(db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-live')).toMatchObject({
        status: 'DONE',
      });
      expect(readFileSync(video, 'utf8')).toBe('original-video');
    } finally {
      db.close();
    }
  });
});
