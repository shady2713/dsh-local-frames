import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import type { MediaClient } from '../src/media.js';
import { controlTask, Pipeline, recoverInterruptedIngests } from '../src/pipeline.js';
import { createRoutes } from '../src/routes.js';
import { SettingsStore } from '../src/settings.js';
import { buildStatus } from '../src/status.js';
import { createTools, type ToolDefinition } from '../src/tool.js';
import type { ToolResult } from '../src/types.js';
import { EnvironmentChecker } from '../src/versions.js';
import type { VisionClient } from '../src/vision.js';
import { fakeExec, healthySubprocess, makeTempDir, mockRequest, mockResponse, writeFixtureFile } from './helpers.js';

// Fixtures live under the OS temp dir; disk capacity is not what these tests cover.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

/**
 * Gate around the real ingest implementation, so a test can put the event loop
 * inside `await ingestPaths(...)` and prove what a scheduler tick does there.
 */
const ingestControl = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  entered: null as (() => void) | null,
}));

vi.mock('../src/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingest.js')>();
  return {
    ...actual,
    ingestPaths: async (...args: Parameters<typeof actual.ingestPaths>) => {
      const wait = ingestControl.wait;
      if (wait !== null) {
        const entered = ingestControl.entered;
        ingestControl.entered = null;
        entered?.();
        await wait;
      }
      return actual.ingestPaths(...args);
    },
  };
});

const AT = '2026-01-01T00:00:00.000Z';
const MODEL = { provider: 'example', model: 'vision' };

const idleMedia: MediaClient = {
  probeDuration: async () => ({ ok: false, error: 'unused' }),
  extractFrame: async () => ({ ok: false, error: 'unused', timedOut: false }),
  decodeGray: async () => ({ ok: false, error: 'unused' }),
  shrinkJpeg: async () => ({ ok: false, error: 'unused' }),
};

function workingMedia(): MediaClient {
  return {
    probeDuration: async () => ({ ok: true, duration: 5 }),
    extractFrame: async (_file, _seconds, dest) => {
      writeFixtureFile(dest, 'frame');
      return { ok: true };
    },
    decodeGray: async () => ({
      ok: true,
      raster: { width: 32, height: 32, pixels: new Uint8Array(32 * 32) },
    }),
    shrinkJpeg: async () => ({ ok: true }),
  };
}

function workingVision(name: string): VisionClient {
  return {
    available: () => true,
    listImageModels: async () => [],
    judge: async (input) => ({
      ok: true,
      ms: 1,
      tokens: 4,
      text: JSON.stringify({
        objects: [name].map((object) => ({
          name: object,
          verdict: 'PRESENT',
          visibility: 'CLEAR',
          confidence: 0.9,
          reason: '看清了',
        })),
      }),
    }),
  };
}

interface Hold {
  entered: Promise<void>;
  release(): void;
}

function holdIngest(): Hold {
  let release!: () => void;
  let markEntered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  ingestControl.wait = wait;
  ingestControl.entered = markEntered;
  return {
    entered,
    release(): void {
      ingestControl.wait = null;
      ingestControl.entered = null;
      release();
    },
  };
}

const openDatabases: LocalFramesDatabase[] = [];

afterEach(() => {
  ingestControl.wait = null;
  ingestControl.entered = null;
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

interface Harness {
  dataDir: string;
  db: LocalFramesDatabase;
  settings: SettingsStore;
  pipeline: Pipeline;
  tool(name: string): ToolDefinition;
}

function harness(options: { media?: MediaClient; vision?: VisionClient } = {}): Harness {
  const dataDir = makeTempDir('lf-issue21-');
  const db = openDatabase(dataDir);
  openDatabases.push(db);
  const settings = new SettingsStore(db);
  const environment = new EnvironmentChecker({
    subprocess: healthySubprocess(),
    dataDir,
    nodeVersion: '24.22.1',
    dshVersion: '0.2.1-rc.5',
    freeGb: () => 100,
  });
  const pipeline = new Pipeline({
    db,
    settings,
    dataDir,
    media: options.media ?? idleMedia,
    vision: options.vision ?? workingVision('object-a'),
    sleep: async () => undefined,
    log: () => undefined,
    minFreeGb: 0,
  });
  const tools = createTools({
    db,
    settings,
    buildStatus: (fresh) =>
      buildStatus({ db, settings, environment, dataDir, freshEnvironment: fresh, pluginVersion: '0.1.0' }),
    log: () => undefined,
    dataDir,
    pipeline,
    environment,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    dataDir,
    db,
    settings,
    pipeline,
    tool(name: string): ToolDefinition {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      return tool;
    },
  };
}

function resultOf(value: unknown): ToolResult {
  return value as ToolResult;
}

function taskRow(db: LocalFramesDatabase, taskId?: string): { task_id: string; status: string } {
  const row = (
    taskId === undefined
      ? db.raw.prepare('SELECT task_id, status FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT 1').get()
      : db.raw.prepare('SELECT task_id, status FROM tasks WHERE task_id = ?').get(taskId)
  ) as { task_id?: string; status?: string } | undefined;
  return { task_id: row?.task_id ?? '', status: row?.status ?? '' };
}

function count(db: LocalFramesDatabase, sql: string, ...params: string[]): number {
  const row = db.raw.prepare(sql).get(...params) as { count?: number } | undefined;
  return row?.count ?? 0;
}

function insertTarget(db: LocalFramesDatabase, name: string): string {
  const targetId = `tgt-${name}`;
  db.raw
    .prepare(
      'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    )
    .run(targetId, name, '{}', '一个用于测试的对象。', AT, AT);
  return targetId;
}

interface SeedOptions {
  status?: string;
  items?: number;
  targetIds?: string[];
}

function seedTask(db: LocalFramesDatabase, options: SeedOptions = {}): string {
  const taskId = 'task-1';
  db.raw
    .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      taskId,
      JSON.stringify({
        targetIds: options.targetIds ?? [],
        frameIntervalSeconds: 2,
        budgetPerTask: 3000,
        model: MODEL,
      }),
      '{}',
      options.status ?? 'RUNNING',
      AT,
      AT,
    );
  for (let index = 0; index < (options.items ?? 0); index += 1) {
    db.raw
      .prepare(
        `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 10, ?, '{}', 'NEW', ?, ?)`,
      )
      .run(`item-${index}`, taskId, `/fixture/video-${index}.mp4`, `hash-${index}`, `video-${index}.mp4`, AT, AT);
  }
  return taskId;
}

function collectReady(h: Harness, root: string, objectName = 'object-a'): void {
  h.settings.update({
    allowRoots: [root],
    modelPool: [{ ...MODEL, concurrency: 1 }],
    budgetPerTask: 100,
    objectsPerCall: 5,
  });
  insertTarget(h.db, objectName);
}

describe('issue #21: import race at task start', () => {
  it('keeps lf_collect_start INGESTING until ingest finishes; a tick there cannot finish or orphan it', async () => {
    const h = harness();
    const root = makeTempDir('lf-issue21-root-');
    collectReady(h, root);
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
    const hold = holdIngest();
    const starting = h.tool('lf_collect_start').execute({ paths: [file] }, fakeExec());
    await hold.entered;

    const task = taskRow(h.db);
    expect(task.status).toBe('INGESTING');
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM items')).toBe(0);

    // The 5-second scheduler tick lands while the import is still running.
    await h.pipeline.runUntilIdle();
    expect(taskRow(h.db).status).toBe('INGESTING');
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM items')).toBe(0);
    expect(count(h.db, "SELECT COUNT(*) AS count FROM tasks WHERE status = 'DONE'")).toBe(0);

    h.pipeline.stop();
    hold.release();
    const started = resultOf(await starting);
    expect(started.status).toBe('OK');
    expect(taskRow(h.db).status).toBe('RUNNING');
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM items')).toBe(1);
    expect(count(h.db, "SELECT COUNT(*) AS count FROM items WHERE state = 'NEW'")).toBe(1);
    // No task may be DONE while its item has neither a frame nor a call.
    expect(taskRow(h.db).status).not.toBe('DONE');
  });

  it('refuses a second lf_collect_start while a task is INGESTING', async () => {
    const h = harness();
    const root = makeTempDir('lf-issue21-root-');
    collectReady(h, root);
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
    seedTask(h.db, { status: 'INGESTING' });
    const result = resultOf(await h.tool('lf_collect_start').execute({ paths: [file] }, fakeExec()));
    expect(result.status).toBe('ERROR');
    expect(result.message).toContain('已有进行中');
  });
});

describe('issue #21: importing into an existing task', () => {
  it('lf_video_add marks the task INGESTING and restores RUNNING only after ingest', async () => {
    const h = harness();
    const root = makeTempDir('lf-issue21-add-');
    collectReady(h, root);
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
    seedTask(h.db, { status: 'RUNNING' });
    const hold = holdIngest();
    const adding = h.tool('lf_video_add').execute({ path: file }, fakeExec());
    await hold.entered;

    expect(taskRow(h.db).status).toBe('INGESTING');
    await h.pipeline.runUntilIdle();
    expect(taskRow(h.db).status).toBe('INGESTING');
    expect(count(h.db, "SELECT COUNT(*) AS count FROM tasks WHERE status = 'DONE'")).toBe(0);

    h.pipeline.stop();
    hold.release();
    const added = resultOf(await adding);
    expect(added.status).toBe('OK');
    expect(taskRow(h.db).status).toBe('RUNNING');
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM items')).toBe(1);
  });

  it('returns a PAUSED task to PAUSED after the import', async () => {
    const h = harness();
    const root = makeTempDir('lf-issue21-paused-');
    collectReady(h, root);
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
    seedTask(h.db, { status: 'PAUSED' });
    const hold = holdIngest();
    const adding = h.tool('lf_video_add').execute({ path: file }, fakeExec());
    await hold.entered;
    expect(taskRow(h.db).status).toBe('INGESTING');
    hold.release();
    const added = resultOf(await adding);
    expect(added.status).toBe('OK');
    expect(taskRow(h.db).status).toBe('PAUSED');
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM items')).toBe(1);
  });

  it('route /videos/add also holds the task in INGESTING until the import finishes', async () => {
    const h = harness();
    const root = makeTempDir('lf-issue21-route-');
    collectReady(h, root);
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
    seedTask(h.db, { status: 'RUNNING' });
    const routes = createRoutes({
      buildStatus: async () =>
        buildStatus({
          db: h.db,
          settings: h.settings,
          environment: new EnvironmentChecker({
            subprocess: healthySubprocess(),
            dataDir: h.dataDir,
            nodeVersion: '24.22.1',
            dshVersion: '0.2.1-rc.5',
            freeGb: () => 100,
          }),
          dataDir: h.dataDir,
          freshEnvironment: false,
          pluginVersion: '0.1.0',
        }),
      log: () => undefined,
      db: h.db,
      settings: h.settings,
      dataDir: h.dataDir,
      pipeline: h.pipeline,
    });
    const hold = holdIngest();
    const adding = postJson(routes, '/api/local-frames/videos/add', { path: file });
    await hold.entered;

    expect(taskRow(h.db).status).toBe('INGESTING');
    await h.pipeline.runUntilIdle();
    expect(taskRow(h.db).status).toBe('INGESTING');

    h.pipeline.stop();
    hold.release();
    const response = await adding;
    expect(response.status).toBe(200);
    expect(taskRow(h.db).status).toBe('RUNNING');
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM items')).toBe(1);
  });
});

describe('issue #21: cancel and restart', () => {
  it('cancels an INGESTING task, and a finished ingest does not resurrect it', async () => {
    const h = harness();
    const root = makeTempDir('lf-issue21-cancel-');
    collectReady(h, root);
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
    const hold = holdIngest();
    const starting = h.tool('lf_collect_start').execute({ paths: [file] }, fakeExec());
    await hold.entered;

    const taskId = taskRow(h.db).task_id;
    expect(taskRow(h.db).status).toBe('INGESTING');
    const cancelled = controlTask(h.db, h.dataDir, taskId, 'cancel');
    expect(cancelled.ok).toBe(true);
    expect(cancelled.status).toBe('CANCELLED');
    expect(taskRow(h.db).status).toBe('CANCELLED');

    h.pipeline.stop();
    hold.release();
    await starting;
    expect(taskRow(h.db).status).toBe('CANCELLED');
  });

  it('resumes an interrupted INGESTING task that still has unfinished items', async () => {
    const h = harness({ media: workingMedia(), vision: workingVision('object-a') });
    const root = makeTempDir('lf-issue21-recover-');
    h.settings.update({
      allowRoots: [root],
      modelPool: [{ ...MODEL, concurrency: 1 }],
      budgetPerTask: 100,
      objectsPerCall: 5,
    });
    const targetId = insertTarget(h.db, 'object-a');
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
    const taskId = seedTask(h.db, { status: 'INGESTING', items: 1, targetIds: [targetId] });
    h.db.raw.prepare('UPDATE items SET local_path = ? WHERE task_id = ?').run(file, taskId);

    const recovered = recoverInterruptedIngests(h.db);
    expect(recovered.resumed).toContain(taskId);
    expect(taskRow(h.db, taskId).status).toBe('RUNNING');
    expect(taskRow(h.db, taskId).status).not.toBe('DONE');

    await h.pipeline.runUntilIdle();
    expect(taskRow(h.db, taskId).status).toBe('DONE');
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM frames')).toBeGreaterThan(0);
    expect(count(h.db, 'SELECT COUNT(*) AS count FROM calls')).toBeGreaterThan(0);
  });

  it('never marks an interrupted INGESTING task with no items as DONE', async () => {
    const h = harness();
    const taskId = seedTask(h.db, { status: 'INGESTING' });
    const status = resultOf(await h.tool('lf_status').execute({}, fakeExec()));
    expect(status.message).toContain('入库中');

    const recovered = recoverInterruptedIngests(h.db);
    expect(recovered.paused).toContain(taskId);
    expect(taskRow(h.db, taskId).status).toBe('PAUSED');
    expect(taskRow(h.db, taskId).status).not.toBe('DONE');

    await h.pipeline.runUntilIdle();
    expect(taskRow(h.db, taskId).status).toBe('PAUSED');
    expect(count(h.db, "SELECT COUNT(*) AS count FROM tasks WHERE status = 'DONE'")).toBe(0);
  });
});

function postJson(
  routes: ReturnType<typeof createRoutes>,
  url: string,
  body: unknown,
): Promise<ReturnType<typeof mockResponse>['result']> {
  const { res, result } = mockResponse();
  return Promise.resolve(
    routes(
      mockRequest({
        method: 'POST',
        url,
        headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      res,
    ),
  ).then(() => result);
}
