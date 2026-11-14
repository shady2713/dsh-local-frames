import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import type { MediaClient } from '../src/media.js';
import { controlTask, Pipeline } from '../src/pipeline.js';
import {
  defaultSettings,
  MODEL_POOL_MAX_ENTRIES,
  MODEL_POOL_TOTAL_CONCURRENCY_MAX,
  parseSettings,
  SettingsError,
  SettingsStore,
} from '../src/settings.js';
import type { ModelPoolEntry } from '../src/types.js';
import type { VisionClient, VisionResult } from '../src/vision.js';
import { makeTempDir, writeFixtureFile } from './helpers.js';

// Fixtures live under the OS temp dir; disk capacity is not what these tests cover.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

const AT = '2026-01-01T00:00:00.000Z';
const MODEL_A = { provider: 'example', model: 'vision-a' };
const MODEL_B = { provider: 'example', model: 'vision-b' };
const NAME_A = `${MODEL_A.provider}/${MODEL_A.model}`;
const NAME_B = `${MODEL_B.provider}/${MODEL_B.model}`;

const unusedMedia: MediaClient = {
  probeDuration: async () => ({ ok: false, error: 'unused' }),
  extractFrame: async () => ({ ok: false, error: 'unused', timedOut: false }),
  decodeGray: async () => ({ ok: false, error: 'unused' }),
  shrinkJpeg: async () => ({ ok: false, error: 'unused' }),
};

interface SeedOptions {
  frameCount?: number;
  objectCount?: number;
  budgetPerTask?: number;
  /** Pre-existing call rows, simulating a frame that was already attempted. */
  calls?: Array<{ frameIndex: number; model: string; count?: number }>;
}

interface Seeded {
  taskId: string;
  frameIds: string[];
  names: string[];
}

/** Seed one FRAMED item with PENDING frames and the requested task objects. */
function seedTask(db: LocalFramesDatabase, dataDir: string, options: SeedOptions = {}): Seeded {
  const taskId = 'task';
  const frameCount = options.frameCount ?? 1;
  const objectCount = options.objectCount ?? 1;
  const names = Array.from({ length: objectCount }, (_, index) => `object-${index + 1}`);
  const targetIds = names.map((_, index) => `tgt-${index + 1}`);
  for (let index = 0; index < names.length; index += 1) {
    db.raw
      .prepare(
        'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      )
      .run(`tgt-${index + 1}`, names[index] ?? '', '{}', '一个物体。', AT, AT);
  }
  db.raw
    .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      taskId,
      JSON.stringify({
        targetIds,
        frameIntervalSeconds: 2,
        budgetPerTask: options.budgetPerTask ?? 3000,
        model: MODEL_A,
      }),
      '{}',
      'RUNNING',
      AT,
      AT,
    );
  db.raw
    .prepare(
      `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
       VALUES ('item', ?, '/tmp/video.mp4', 'hash', 10, 'video.mp4', '{"duration":2}', 'FRAMED', ?, ?)`,
    )
    .run(taskId, AT, AT);
  const frameIds: string[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const frameId = `frame-${index}`;
    frameIds.push(frameId);
    const framePath = join(dataDir, 'frames', taskId, `${frameId}.jpg`);
    writeFixtureFile(framePath, frameId);
    db.raw
      .prepare(
        `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
         VALUES (?, 'item', ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(frameId, 1000 + index, framePath, (index + 1).toString(16).padStart(16, '0'), AT, AT);
  }
  for (const seeded of options.calls ?? []) {
    for (let index = 0; index < (seeded.count ?? 1); index += 1) {
      db.raw
        .prepare(
          'INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, ?, 1, 1, 0, NULL, ?)',
        )
        .run(`seed-${seeded.frameIndex}-${index}`, taskId, `frame-${seeded.frameIndex}`, seeded.model, AT);
    }
  }
  return { taskId, frameIds, names };
}

function makeSettings(db: LocalFramesDatabase, modelPool: ModelPoolEntry[], patch: Record<string, unknown> = {}): SettingsStore {
  const settings = new SettingsStore(db);
  settings.update({ modelPool, budgetPerTask: 1000, objectsPerCall: 40, ...patch });
  return settings;
}

function makePipeline(db: LocalFramesDatabase, settings: SettingsStore, dataDir: string, vision: VisionClient): Pipeline {
  return new Pipeline({ db, settings, dataDir, media: unusedMedia, vision, sleep: async () => undefined, minFreeGb: 0 });
}

/** Object names from the batch's object table, in prompt order. */
function promptNames(prompt: string): string[] {
  const table = prompt.split('对象表：')[1] ?? '';
  return [...table.matchAll(/"name":"([^"]+)"/gu)].map((match) => match[1] ?? '');
}

function allPresent(prompt: string): VisionResult {
  return {
    ok: true,
    text: JSON.stringify({
      objects: promptNames(prompt).map((name) => ({
        name,
        verdict: 'PRESENT',
        visibility: 'CLEAR',
        confidence: 0.9,
        reason: '看清了',
      })),
    }),
    tokens: 4,
    ms: 1,
  };
}

function retryable(message = 'HTTP 503'): VisionResult {
  return { ok: false, kind: 'retryable', message, retryAfterMs: 1 };
}

function count(db: LocalFramesDatabase, sql: string, ...params: string[]): number {
  const row = db.raw.prepare(sql).get(...params) as { count?: number } | undefined;
  return row?.count ?? 0;
}

function frameRow(db: LocalFramesDatabase, frameId: string): { state?: string; path?: string | null; error?: string | null } {
  return db.raw.prepare('SELECT state, path, error FROM frames WHERE frame_id = ?').get(frameId) as {
    state?: string;
    path?: string | null;
    error?: string | null;
  };
}

function taskRow(db: LocalFramesDatabase): { status?: string; progress_json?: string } {
  return db.raw.prepare('SELECT status, progress_json FROM tasks WHERE task_id = ?').get('task') as {
    status?: string;
    progress_json?: string;
  };
}

function callModels(db: LocalFramesDatabase, frameId?: string): string[] {
  const rows = (
    frameId === undefined
      ? db.raw.prepare('SELECT model FROM calls ORDER BY rowid ASC').all()
      : db.raw.prepare('SELECT model FROM calls WHERE frame_id = ? ORDER BY rowid ASC').all(frameId)
  ) as Array<{ model: string }>;
  return rows.map((row) => row.model);
}

describe('issue #19: model pool scheduling', () => {
  it('spreads frames across two models with 3 concurrency each, without cross-assignment', async () => {
    const dataDir = makeTempDir('lf-issue19-pool-');
    const db = openDatabase(dataDir);
    const pool: ModelPoolEntry[] = [
      { ...MODEL_A, concurrency: 3 },
      { ...MODEL_B, concurrency: 3 },
    ];
    const settings = makeSettings(db, pool);
    const seeded = seedTask(db, dataDir, { frameCount: 8 });
    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();
    let totalInFlight = 0;
    let peakTotalInFlight = 0;
    const framesByModel = new Map<string, Set<string>>();
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        const modelName = `${input.provider}/${input.model}`;
        const frameName = basename(input.imagePath);
        const active = (inFlight.get(modelName) ?? 0) + 1;
        inFlight.set(modelName, active);
        peak.set(modelName, Math.max(peak.get(modelName) ?? 0, active));
        totalInFlight += 1;
        peakTotalInFlight = Math.max(peakTotalInFlight, totalInFlight);
        const frames = framesByModel.get(modelName) ?? new Set<string>();
        frames.add(frameName);
        framesByModel.set(modelName, frames);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight.set(modelName, active - 1);
        totalInFlight -= 1;
        return allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(peak.get(NAME_A)).toBe(3);
      expect(peak.get(NAME_B)).toBe(3);
      expect(peakTotalInFlight).toBe(6);
      expect(peakTotalInFlight).toBeLessThanOrEqual(MODEL_POOL_TOTAL_CONCURRENCY_MAX);

      const byFrame = new Map<string, Set<string>>();
      for (const row of db.raw.prepare('SELECT frame_id, model FROM calls ORDER BY rowid ASC').all() as Array<{
        frame_id: string;
        model: string;
      }>) {
        const models = byFrame.get(row.frame_id) ?? new Set<string>();
        models.add(row.model);
        byFrame.set(row.frame_id, models);
      }
      for (const frameId of seeded.frameIds) {
        expect(byFrame.get(frameId)?.size).toBe(1);
      }
      // Each model only processes the frames assigned to it.
      expect(framesByModel.get(NAME_A)?.size).toBe(4);
      expect(framesByModel.get(NAME_B)?.size).toBe(4);
      for (const [modelName, frames] of framesByModel) {
        for (const frameName of frames) {
          const frameId = frameName.replace(/\.jpg$/u, '');
          expect(byFrame.get(frameId)?.has(modelName)).toBe(true);
        }
      }
      expect(count(db, "SELECT COUNT(*) AS count FROM frames WHERE state = 'JUDGED'")).toBe(8);
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls')).toBe(8);
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(8);
    } finally {
      db.close();
    }
  });

  it('keeps all batches and retries of one frame on its assigned model, serially', async () => {
    const dataDir = makeTempDir('lf-issue19-batches-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(
      db,
      [
        { ...MODEL_A, concurrency: 4 },
        { ...MODEL_B, concurrency: 4 },
      ],
      { objectsPerCall: 2 },
    );
    const seeded = seedTask(db, dataDir, { objectCount: 5 });
    const models: string[] = [];
    let calls = 0;
    let inFlight = 0;
    let peak = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        models.push(input.model);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return calls === 1 ? retryable() : allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      // objectsPerCall = 2 for 5 objects => 3 batches, plus one retry on the first batch.
      expect(calls).toBe(4);
      expect(peak).toBe(1);
      expect(new Set(models)).toEqual(new Set([MODEL_A.model]));
      expect(frameRow(db, seeded.frameIds[0] ?? '').state).toBe('JUDGED');
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(5);
      expect(callModels(db)).toEqual([NAME_A, NAME_A, NAME_A, NAME_A]);
    } finally {
      db.close();
    }
  });

  it('fails a frame without partial labels when any batch exhausts its attempts', async () => {
    const dataDir = makeTempDir('lf-issue19-partial-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(
      db,
      [
        { ...MODEL_A, concurrency: 1 },
        { ...MODEL_B, concurrency: 1 },
      ],
      { objectsPerCall: 2 },
    );
    const seeded = seedTask(db, dataDir, { objectCount: 4 });
    let calls = 0;
    let inFlight = 0;
    let peak = 0;
    const models: string[] = [];
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        models.push(input.model);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return calls === 1 ? allPresent(input.prompt) : retryable();
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      // Batch 1 succeeds (1 call); batch 2 burns all five attempts.
      expect(calls).toBe(6);
      expect(peak).toBe(1);
      expect(new Set(models)).toEqual(new Set([MODEL_A.model]));
      const frame = frameRow(db, seeded.frameIds[0] ?? '');
      expect(frame.state).toBe('FAILED');
      expect(frame.path).toBeNull();
      expect(frame.error).toContain('累计 6 次');
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(0);
      expect(callModels(db)).toEqual([NAME_A, NAME_A, NAME_A, NAME_A, NAME_A, NAME_A]);
    } finally {
      db.close();
    }
  });

  it('keeps a frame on the model already recorded in calls even when another model is idle', async () => {
    const dataDir = makeTempDir('lf-issue19-sticky-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, [
      { ...MODEL_A, concurrency: 1 },
      { ...MODEL_B, concurrency: 8 },
    ]);
    const seeded = seedTask(db, dataDir, {
      frameCount: 2,
      calls: [
        { frameIndex: 0, model: NAME_A },
        { frameIndex: 1, model: NAME_A },
      ],
    });
    const models: string[] = [];
    let inFlightA = 0;
    let peakA = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        models.push(`${input.provider}/${input.model}`);
        if (input.model === MODEL_A.model) {
          inFlightA += 1;
          peakA = Math.max(peakA, inFlightA);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlightA -= 1;
        }
        return allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      // Model B has eight free slots but is never used: both frames stay sticky.
      expect(new Set(models)).toEqual(new Set([NAME_A]));
      expect(peakA).toBe(1);
      expect(count(db, "SELECT COUNT(*) AS count FROM calls WHERE model = 'example/vision-b'")).toBe(0);
      for (const frameId of seeded.frameIds) {
        expect(frameRow(db, frameId).state).toBe('JUDGED');
        expect(new Set(callModels(db, frameId))).toEqual(new Set([NAME_A]));
      }
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(2);
    } finally {
      db.close();
    }
  });

  it('keeps the recorded model for a frame even after that model is removed from the pool', async () => {
    const dataDir = makeTempDir('lf-issue19-removed-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, [{ ...MODEL_B, concurrency: 4 }]);
    const seeded = seedTask(db, dataDir, { calls: [{ frameIndex: 0, model: 'retired/vision' }] });
    const models: string[] = [];
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        models.push(`${input.provider}/${input.model}`);
        return allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(models).toEqual(['retired/vision']);
      expect(frameRow(db, seeded.frameIds[0] ?? '').state).toBe('JUDGED');
      expect(new Set(callModels(db))).toEqual(new Set(['retired/vision']));
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('counts calls and budget by actual attempts, including retries', async () => {
    const dataDir = makeTempDir('lf-issue19-budget-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, [{ ...MODEL_A, concurrency: 2 }], {
      budgetPerTask: 2,
      objectsPerCall: 2,
    });
    const seeded = seedTask(db, dataDir, { objectCount: 4, budgetPerTask: 2 });
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return calls === 1 ? retryable() : allPresent(input.prompt);
      },
    };
    const pipeline = makePipeline(db, settings, dataDir, vision);
    try {
      await pipeline.runUntilIdle();
      let task = taskRow(db);
      expect(task.status).toBe('PAUSED');
      expect(task.progress_json).toContain('BUDGET');
      expect(calls).toBe(2);
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls')).toBe(2);
      expect(callModels(db)).toEqual([NAME_A, NAME_A]);
      expect(frameRow(db, seeded.frameIds[0] ?? '').state).toBe('PENDING');
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(0);

      settings.update({ budgetPerTask: 4 });
      expect(controlTask(db, dataDir, 'task', 'resume').ok).toBe(true);
      await pipeline.runUntilIdle();
      task = taskRow(db);
      expect(task.status).toBe('DONE');
      expect(calls).toBe(4);
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls')).toBe(4);
      expect(callModels(db)).toEqual([NAME_A, NAME_A, NAME_A, NAME_A]);
      expect(frameRow(db, seeded.frameIds[0] ?? '').state).toBe('JUDGED');
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(4);
    } finally {
      db.close();
    }
  });

  it('matches the old single-model behavior with a one-row pool', async () => {
    const dataDir = makeTempDir('lf-issue19-single-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, [{ ...MODEL_A, concurrency: 2 }]);
    const seeded = seedTask(db, dataDir, { frameCount: 4, objectCount: 10 });
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(peak).toBe(2);
      expect(calls).toBe(4);
      for (const frameId of seeded.frameIds) {
        expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?', frameId)).toBe(1);
        expect(frameRow(db, frameId).state).toBe('JUDGED');
      }
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(40);
    } finally {
      db.close();
    }
  });
});

describe('issue #19: model pool settings', () => {
  it('validates the pool shape, per-row concurrency, total cap and duplicates', () => {
    const base = defaultSettings();
    const first: ModelPoolEntry = { provider: 'p1', model: 'm1', concurrency: 2 };
    const second: ModelPoolEntry = { provider: 'p2', model: 'm2', concurrency: 4 };
    const good = [first, second];
    expect(parseSettings({ ...base, modelPool: good }).modelPool).toEqual(good);
    expect(parseSettings({ ...base, modelPool: [] }).modelPool).toEqual([]);
    expect(
      parseSettings({
        ...base,
        modelPool: [
          { provider: 'p1', model: 'm1', concurrency: 8 },
          { provider: 'p2', model: 'm2', concurrency: 8 },
        ],
      }).modelPool,
    ).toHaveLength(2);

    const sixth = Array.from({ length: MODEL_POOL_MAX_ENTRIES + 1 }, (_, index) => ({
      provider: `p${index}`,
      model: `m${index}`,
      concurrency: 1,
    }));
    expect(() => parseSettings({ ...base, modelPool: sixth })).toThrow(/at most 5/);

    const fiveTimesFour = Array.from({ length: 5 }, (_, index) => ({
      provider: `p${index}`,
      model: `m${index}`,
      concurrency: 4,
    }));
    expect(() => parseSettings({ ...base, modelPool: fiveTimesFour })).toThrow(/concurrency total/);
    expect(() =>
      parseSettings({
        ...base,
        modelPool: [
          { provider: 'a', model: 'a', concurrency: 8 },
          { provider: 'b', model: 'b', concurrency: 8 },
          { provider: 'c', model: 'c', concurrency: 1 },
        ],
      }),
    ).toThrow(/concurrency total/);

    for (const concurrency of [0, 9, 2.5]) {
      expect(() => parseSettings({ ...base, modelPool: [{ ...first, concurrency }] })).toThrow(SettingsError);
    }
    expect(() => parseSettings({ ...base, modelPool: [first, { ...first, concurrency: 1 }] })).toThrow(/duplicates/);
    expect(() => parseSettings({ ...base, modelPool: [{ provider: 'p', model: 'm' }] })).toThrow(SettingsError);
    expect(() => parseSettings({ ...base, modelPool: [{ provider: '', model: 'm', concurrency: 1 }] })).toThrow(
      SettingsError,
    );
    expect(() => parseSettings({ ...base, modelPool: [{ ...first, extra: true }] })).toThrow(/unknown field/);
  });

  it('rejects invalid pool saves and keeps the previous value', () => {
    const db = openDatabase(makeTempDir('lf-issue19-settings-'));
    try {
      const store = new SettingsStore(db);
      const first: ModelPoolEntry = { provider: 'p1', model: 'm1', concurrency: 2 };
      const second: ModelPoolEntry = { provider: 'p2', model: 'm2', concurrency: 4 };
      const good = [first, second];
      store.update({ modelPool: good });
      const invalidPools: unknown[] = [
        Array.from({ length: MODEL_POOL_MAX_ENTRIES + 1 }, (_, index) => ({
          provider: `p${index}`,
          model: `m${index}`,
          concurrency: 1,
        })),
        [{ ...first, concurrency: 0 }],
        [{ ...first, concurrency: 9 }],
        [{ ...first, concurrency: 2.5 }],
        [
          { provider: 'a', model: 'a', concurrency: 8 },
          { provider: 'b', model: 'b', concurrency: 8 },
          { provider: 'c', model: 'c', concurrency: 1 },
        ],
        Array.from({ length: 5 }, (_, index) => ({ provider: `p${index}`, model: `m${index}`, concurrency: 4 })),
        [first, { ...first, concurrency: 1 }],
        [{ provider: 'p', model: 'm' }],
        [{ provider: 'p', model: 'm', concurrency: 1, extra: true }],
      ];
      for (const modelPool of invalidPools) {
        expect(() => store.update({ modelPool })).toThrow(SettingsError);
        expect(store.load().modelPool).toEqual(good);
      }
      expect(store.load().modelPool).toEqual(good);
    } finally {
      db.close();
    }
  });

  it('migrates legacy settings without modelPool and keeps old writes working', () => {
    const withConcurrency = openDatabase(makeTempDir('lf-issue19-migrate-6-'));
    const withoutConcurrency = openDatabase(makeTempDir('lf-issue19-migrate-2-'));
    const withoutModel = openDatabase(makeTempDir('lf-issue19-migrate-empty-'));
    const oldWriter = openDatabase(makeTempDir('lf-issue19-old-writer-'));
    try {
      withConcurrency.raw
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
        .run(
          'settings',
          JSON.stringify({
            model: { provider: 'legacy', model: 'vision' },
            visionConcurrency: 6,
            dataDirLimitGb: 50,
            budgetPerTask: 3000,
            frameIntervalSeconds: 2,
            allowRoots: [],
          }),
        );
      expect(new SettingsStore(withConcurrency).load().modelPool).toEqual([
        { provider: 'legacy', model: 'vision', concurrency: 6 },
      ]);

      withoutConcurrency.raw
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
        .run(
          'settings',
          JSON.stringify({
            model: { provider: 'legacy', model: 'vision' },
            dataDirLimitGb: 50,
            budgetPerTask: 3000,
            frameIntervalSeconds: 2,
            allowRoots: [],
          }),
        );
      const migratedDefault = new SettingsStore(withoutConcurrency).load();
      expect(migratedDefault.modelPool).toEqual([{ provider: 'legacy', model: 'vision', concurrency: 2 }]);
      expect(migratedDefault.visionConcurrency).toBe(2);

      withoutModel.raw
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
        .run(
          'settings',
          JSON.stringify({
            model: null,
            dataDirLimitGb: 50,
            budgetPerTask: 3000,
            frameIntervalSeconds: 2,
            allowRoots: [],
          }),
        );
      expect(new SettingsStore(withoutModel).load().modelPool).toEqual([]);

      const store = new SettingsStore(oldWriter);
      store.update({ model: { provider: 'old', model: 'vision' }, visionConcurrency: 5 });
      expect(store.load().modelPool).toEqual([{ provider: 'old', model: 'vision', concurrency: 5 }]);
      store.update({ visionConcurrency: 3 });
      expect(store.load().modelPool).toEqual([{ provider: 'old', model: 'vision', concurrency: 3 }]);
      store.update({ model: null });
      expect(store.load().modelPool).toEqual([]);
    } finally {
      withConcurrency.close();
      withoutConcurrency.close();
      withoutModel.close();
      oldWriter.close();
    }
  });

  it('allows saving an empty pool but refuses to start judging', async () => {
    const dataDir = makeTempDir('lf-issue19-empty-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ modelPool: [] });
    expect(settings.load().modelPool).toEqual([]);
    seedTask(db, dataDir);
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => allPresent(input.prompt),
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();
      const task = taskRow(db);
      expect(task.status).toBe('PAUSED');
      expect(task.progress_json).toContain('NO_MODEL');
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls')).toBe(0);
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels')).toBe(0);
      expect(frameRow(db, 'frame-0').state).toBe('PENDING');
    } finally {
      db.close();
    }
  });

  it('keeps objectsPerCall at 1–300 with default 24', () => {
    const base = defaultSettings();
    expect(base.objectsPerCall).toBe(24);
    expect(parseSettings({ ...base, objectsPerCall: 1 }).objectsPerCall).toBe(1);
    expect(parseSettings({ ...base, objectsPerCall: 300 }).objectsPerCall).toBe(300);
    expect(() => parseSettings({ ...base, objectsPerCall: 0 })).toThrow(SettingsError);
    expect(() => parseSettings({ ...base, objectsPerCall: 301 })).toThrow(SettingsError);
    expect(() => parseSettings({ ...base, objectsPerCall: 2.5 })).toThrow(SettingsError);
  });
});
