import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import type { MediaClient } from '../src/media.js';
import { Pipeline } from '../src/pipeline.js';
import {
  DEFAULT_SETTINGS,
  defaultSettings,
  mergeSettings,
  parseSettings,
  SettingsError,
  SettingsStore,
} from '../src/settings.js';
import type { VisionClient, VisionResult } from '../src/vision.js';
import { makeTempDir, writeFixtureFile } from './helpers.js';

// Fixtures live under the OS temp dir; disk capacity is not what these tests cover.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

/** Timeouts the pipeline handed to judgeBatch, captured through the mock below. */
const capturedTimeouts = vi.hoisted(() => [] as Array<number | undefined>);

vi.mock('../src/judge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/judge.js')>();
  return {
    ...actual,
    judgeBatch: (options: Parameters<typeof actual.judgeBatch>[0]) => {
      capturedTimeouts.push(options.timeoutMs);
      return actual.judgeBatch(options);
    },
  };
});

const AT = '2026-01-01T00:00:00.000Z';
const MODEL = { provider: 'example', model: 'vision' };

const unusedMedia: MediaClient = {
  probeDuration: async () => ({ ok: false, error: 'unused' }),
  extractFrame: async () => ({ ok: false, error: 'unused', timedOut: false }),
  decodeGray: async () => ({ ok: false, error: 'unused' }),
  shrinkJpeg: async () => ({ ok: false, error: 'unused' }),
};

function promptNames(prompt: string): string[] {
  const table = prompt.split('对象表：')[1] ?? '';
  return [...table.matchAll(/"name":"([^"]+)"/gu)].map((match) => match[1] ?? '');
}

function allPresent(prompt: string): VisionResult {
  return {
    ok: true,
    ms: 1,
    tokens: 4,
    text: JSON.stringify({
      objects: promptNames(prompt).map((name) => ({
        name,
        verdict: 'PRESENT',
        visibility: 'CLEAR',
        confidence: 0.9,
        reason: '看清了',
      })),
    }),
  };
}

function recordingVision(): VisionClient {
  return {
    available: () => true,
    listImageModels: async () => [],
    judge: async (input) => allPresent(input.prompt),
  };
}

function seedFrame(dataDir: string, db: ReturnType<typeof openDatabase>, frameId: string, tMs: number): void {
  writeFixtureFile(join(dataDir, 'frames', 'task', `${frameId}.jpg`), frameId);
  db.raw
    .prepare(
      `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
       VALUES (?, 'item', ?, ?, ?, 'PENDING', ?, ?)`,
    )
    .run(frameId, tMs, join(dataDir, 'frames', 'task', `${frameId}.jpg`), tMs.toString(16).padStart(16, '0'), AT, AT);
}

describe('issue #22: vision call timeout setting', () => {
  it('defaults to 120 seconds and accepts the 60–300 integer boundaries', () => {
    expect(DEFAULT_SETTINGS.visionCallTimeoutSeconds).toBe(120);
    expect(defaultSettings().visionCallTimeoutSeconds).toBe(120);
    const base = defaultSettings();
    expect(parseSettings({ ...base, visionCallTimeoutSeconds: 60 }).visionCallTimeoutSeconds).toBe(60);
    expect(parseSettings({ ...base, visionCallTimeoutSeconds: 300 }).visionCallTimeoutSeconds).toBe(300);
    for (const bad of [59, 301, 60.5, Number.NaN, '120', null]) {
      expect(() => parseSettings({ ...base, visionCallTimeoutSeconds: bad })).toThrow(SettingsError);
    }
  });

  it('rejects an invalid save, keeps the previous value and persists a valid one', () => {
    const db = openDatabase(makeTempDir('lf-issue22-settings-'));
    try {
      const store = new SettingsStore(db);
      store.update({ visionCallTimeoutSeconds: 180 });
      expect(new SettingsStore(db).load().visionCallTimeoutSeconds).toBe(180);
      for (const bad of [59, 301, 180.5]) {
        expect(() => store.update({ visionCallTimeoutSeconds: bad })).toThrow(SettingsError);
        expect(store.load().visionCallTimeoutSeconds).toBe(180);
      }
    } finally {
      db.close();
    }
  });

  it('migrates a legacy settings row without the field to 120', () => {
    const db = openDatabase(makeTempDir('lf-issue22-legacy-'));
    try {
      db.raw
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
        .run(
          'settings',
          JSON.stringify({
            model: null,
            dataDirLimitGb: 50,
            budgetPerTask: 3000,
            frameIntervalSeconds: 2,
            objectsPerCall: 40,
            allowRoots: [],
          }),
        );
      const loaded = new SettingsStore(db).load();
      expect(loaded.visionCallTimeoutSeconds).toBe(120);
      expect(loaded.objectsPerCall).toBe(40);
      expect(mergeSettings(loaded, { frameIntervalSeconds: 3 }).visionCallTimeoutSeconds).toBe(120);
    } finally {
      db.close();
    }
  });

  it('judgeBatch aborts one call after the injected timeout instead of a fixed 120 seconds', async () => {
    const { judgeBatch } = await vi.importActual<typeof import('../src/judge.js')>('../src/judge.js');
    let attempts = 0;
    const started = Date.now();
    const result = await judgeBatch({
      vision: {
        available: () => true,
        listImageModels: async () => [],
        judge: () => new Promise<VisionResult>(() => undefined),
      },
      provider: MODEL.provider,
      model: MODEL.model,
      objects: [{ name: 'object-a', aliases: {}, definition: '一个物体。' }],
      imagePath: '/tmp/frame.jpg',
      taskId: 'task',
      sleep: async () => undefined,
      beforeCall: () => undefined,
      onAttempt: () => {
        attempts += 1;
      },
      credentialRetry: { used: false },
      timeoutMs: 25,
      maxAttempts: 1,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('25 ms');
      expect(result.reason).toBe('call');
    }
    expect(attempts).toBe(1);
  });

  it('passes the configured milliseconds to judgeBatch and reacts to a later save', async () => {
    const dataDir = makeTempDir('lf-issue22-pipeline-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({
      modelPool: [{ ...MODEL, concurrency: 1 }],
      budgetPerTask: 100,
      objectsPerCall: 5,
    });
    db.raw
      .prepare(
        'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      )
      .run('tgt-1', 'object-a', '{}', '一个用于测试的对象。', AT, AT);
    db.raw
      .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task',
        JSON.stringify({ targetIds: ['tgt-1'], frameIntervalSeconds: 2, budgetPerTask: 100, model: MODEL }),
        '{}',
        'RUNNING',
        AT,
        AT,
      );
    db.raw
      .prepare(
        `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
         VALUES ('item', 'task', '/tmp/video.mp4', 'hash', 10, 'video.mp4', '{"duration":2}', 'FRAMED', ?, ?)`,
      )
      .run(AT, AT);
    seedFrame(dataDir, db, 'frame-1', 1000);
    const pipeline = new Pipeline({
      db,
      settings,
      dataDir,
      media: unusedMedia,
      vision: recordingVision(),
      sleep: async () => undefined,
      minFreeGb: 0,
    });
    try {
      await pipeline.runUntilIdle();
      expect(capturedTimeouts.at(-1)).toBe(120_000);

      settings.update({ visionCallTimeoutSeconds: 300 });
      seedFrame(dataDir, db, 'frame-2', 2000);
      db.raw.prepare("UPDATE tasks SET status = 'RUNNING' WHERE task_id = 'task'").run();
      db.raw.prepare("UPDATE items SET state = 'FRAMED' WHERE item_id = 'item'").run();
      await pipeline.runUntilIdle();
      expect(capturedTimeouts.at(-1)).toBe(300_000);
    } finally {
      db.close();
    }
  });
});
