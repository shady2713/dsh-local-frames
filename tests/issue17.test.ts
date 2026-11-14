import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import type { MediaClient } from '../src/media.js';
import { Pipeline } from '../src/pipeline.js';
import { defaultSettings, parseSettings, SettingsError, SettingsStore } from '../src/settings.js';
import type { VisionClient, VisionResult } from '../src/vision.js';
import { makeTempDir, writeFixtureFile } from './helpers.js';

// Fixtures live under the OS temp dir; disk capacity is not what these tests cover.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

const AT = '2026-01-01T00:00:00.000Z';
const MODEL = { provider: 'example', model: 'vision' };

const unusedMedia: MediaClient = {
  probeDuration: async () => ({ ok: false, error: 'unused' }),
  extractFrame: async () => ({ ok: false, error: 'unused', timedOut: false }),
  decodeGray: async () => ({ ok: false, error: 'unused' }),
  shrinkJpeg: async () => ({ ok: false, error: 'unused' }),
};

interface Seeded {
  taskId: string;
  frameId: string;
  targetIds: string[];
  names: string[];
}

interface SeedOptions {
  objectCount: number;
  budgetPerTask?: number;
  frameId?: string;
  /** Pre-existing call rows for the frame, simulating an earlier run/restart. */
  calls?: number;
}

/** Seed one FRAMED item with one PENDING frame and the requested task objects. */
function seedFrame(db: LocalFramesDatabase, dataDir: string, options: SeedOptions): Seeded {
  const taskId = 'task';
  const frameId = options.frameId ?? 'frame-1';
  const names = Array.from({ length: options.objectCount }, (_, index) => `object-${index + 1}`);
  const targetIds = names.map((_, index) => `tgt-${index + 1}`);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (name === undefined) continue;
    db.raw
      .prepare(
        'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      )
      .run(`tgt-${index + 1}`, name, '{}', '一个物体。', AT, AT);
  }
  db.raw
    .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      taskId,
      JSON.stringify({
        targetIds,
        frameIntervalSeconds: 2,
        budgetPerTask: options.budgetPerTask ?? 3000,
        model: MODEL,
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
  const framePath = join(dataDir, 'frames', taskId, `${frameId}.jpg`);
  writeFixtureFile(framePath, 'frame');
  db.raw
    .prepare(
      `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
       VALUES (?, 'item', 1000, ?, '0123456789abcdef', 'PENDING', ?, ?)`,
    )
    .run(frameId, framePath, AT, AT);
  for (let index = 0; index < (options.calls ?? 0); index += 1) {
    db.raw
      .prepare(
        'INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, ?, 1, 1, 0, NULL, ?)',
      )
      .run(`call-seed-${index}`, taskId, frameId, 'example/vision', AT);
  }
  return { taskId, frameId, targetIds, names };
}

function makeSettings(db: LocalFramesDatabase, patch: Record<string, unknown> = {}): SettingsStore {
  const settings = new SettingsStore(db);
  settings.update({
    model: MODEL,
    visionConcurrency: 1,
    budgetPerTask: 100,
    ...patch,
  });
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

function recordingVision(): { vision: VisionClient; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    vision: {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        prompts.push(input.prompt);
        return allPresent(input.prompt);
      },
    },
  };
}

function retryable(message = 'HTTP 503'): VisionResult {
  return { ok: false, kind: 'retryable', message, retryAfterMs: 1 };
}

function frameRow(db: LocalFramesDatabase, frameId: string): { state?: string; path?: string | null; error?: string | null; judge_json?: string | null } {
  return db.raw.prepare('SELECT state, path, error, judge_json FROM frames WHERE frame_id = ?').get(frameId) as {
    state?: string;
    path?: string | null;
    error?: string | null;
    judge_json?: string | null;
  };
}

function count(db: LocalFramesDatabase, sql: string, ...params: string[]): number {
  const row = db.raw.prepare(sql).get(...params) as { count?: number } | undefined;
  return row?.count ?? 0;
}

function labelNames(db: LocalFramesDatabase, frameId: string): string[] {
  return (
    db.raw
      .prepare(
        `SELECT targets.name AS name FROM labels
         JOIN targets ON targets.target_id = labels.target_id
         WHERE labels.frame_id = ?`,
      )
      .all(frameId) as Array<{ name: string }>
  ).map((row) => row.name);
}

describe('issue #17: object batching per frame', () => {
  it('splits 90 objects into batches of 40 and commits every verdict once', async () => {
    const dataDir = makeTempDir('lf-issue17-90-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 40, budgetPerTask: 100 });
    const seeded = seedFrame(db, dataDir, { objectCount: 90 });
    const { vision, prompts } = recordingVision();
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(prompts.map((prompt) => promptNames(prompt).length)).toEqual([40, 40, 10]);
      expect(prompts.flatMap((prompt) => promptNames(prompt))).toEqual(seeded.names);
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?', seeded.frameId)).toBe(3);
      expect(count(db, "SELECT COUNT(*) AS count FROM frames WHERE state = 'JUDGED'")).toBe(1);
      expect(labelNames(db, seeded.frameId).sort()).toEqual([...seeded.names].sort());

      const frame = frameRow(db, seeded.frameId);
      expect(frame.state).toBe('JUDGED');
      const judged = JSON.parse(frame.judge_json ?? '{}') as { objects?: Array<{ name: string }> };
      expect(judged.objects?.map((object) => object.name)).toEqual(seeded.names);
    } finally {
      db.close();
    }
  });

  it('still uses one call when the object count equals objectsPerCall', async () => {
    const dataDir = makeTempDir('lf-issue17-equal-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 5 });
    const seeded = seedFrame(db, dataDir, { objectCount: 5 });
    const { vision, prompts } = recordingVision();
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(prompts).toHaveLength(1);
      expect(promptNames(prompts[0] ?? '')).toEqual(seeded.names);
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?', seeded.frameId)).toBe(1);
      expect(labelNames(db, seeded.frameId).sort()).toEqual([...seeded.names].sort());
      expect(frameRow(db, seeded.frameId).state).toBe('JUDGED');
    } finally {
      db.close();
    }
  });

  it('fails the whole frame without labels when a later batch exhausts its retries', async () => {
    const dataDir = makeTempDir('lf-issue17-batch-fail-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 2, budgetPerTask: 100 });
    const seeded = seedFrame(db, dataDir, { objectCount: 4 });
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        // The first batch succeeds; the second never does.
        if (promptNames(input.prompt).includes('object-3')) return retryable();
        return allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(calls).toBe(6); // first batch once + second batch five attempts
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?', seeded.frameId)).toBe(6);
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels WHERE frame_id = ?', seeded.frameId)).toBe(0);
      const frame = frameRow(db, seeded.frameId);
      expect(frame.state).toBe('FAILED');
      expect(frame.path).toBeNull();
      expect(frame.error).toContain('累计 6 次');
    } finally {
      db.close();
    }
  });

  it('counts every retry against calls and the task budget', async () => {
    const dataDir = makeTempDir('lf-issue17-budget-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 1, budgetPerTask: 4 });
    const seeded = seedFrame(db, dataDir, { objectCount: 2, budgetPerTask: 4 });
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        return calls % 2 === 1 ? retryable() : allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(calls).toBe(4); // fail + success for each of the two batches
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE task_id = ?', seeded.taskId)).toBe(4);
      expect(labelNames(db, seeded.frameId).sort()).toEqual([...seeded.names].sort());
      expect(frameRow(db, seeded.frameId).state).toBe('JUDGED');
    } finally {
      db.close();
    }
  });

  it('pauses at the task budget after retries and leaves no partial labels', async () => {
    const dataDir = makeTempDir('lf-issue17-budget-pause-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 1, budgetPerTask: 3 });
    const seeded = seedFrame(db, dataDir, { objectCount: 2, budgetPerTask: 3 });
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        return calls % 2 === 1 ? retryable() : allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(calls).toBe(3);
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE task_id = ?', seeded.taskId)).toBe(3);
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels WHERE frame_id = ?', seeded.frameId)).toBe(0);
      expect(frameRow(db, seeded.frameId).state).toBe('PENDING');
      const task = db.raw.prepare('SELECT status, progress_json FROM tasks WHERE task_id = ?').get(seeded.taskId) as {
        status?: string;
        progress_json?: string;
      };
      expect(task.status).toBe('PAUSED');
      expect(task.progress_json).toContain('BUDGET');
    } finally {
      db.close();
    }
  });

  it('allows the sixth automatic call for a three-batch frame', async () => {
    const dataDir = makeTempDir('lf-issue17-5k-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 2, budgetPerTask: 100 });
    const seeded = seedFrame(db, dataDir, { objectCount: 6 });
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        // Four retryable failures, then the first batch succeeds on its fifth
        // attempt. The next batch's first call is the sixth automatic call.
        return calls <= 4 ? retryable() : allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(calls).toBe(7); // 5 for batch 1 + 1 for batch 2 + 1 for batch 3
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?', seeded.frameId)).toBe(7);
      expect(labelNames(db, seeded.frameId).sort()).toEqual([...seeded.names].sort());
      expect(frameRow(db, seeded.frameId).state).toBe('JUDGED');
    } finally {
      db.close();
    }
  });

  it('does not call the model again when a frame already spent its 5K attempts', async () => {
    const dataDir = makeTempDir('lf-issue17-exhausted-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 2, budgetPerTask: 100 });
    // 6 objects / 2 per call = 3 batches, so the frame cap is 5 × 3 = 15 calls.
    const seeded = seedFrame(db, dataDir, { objectCount: 6, calls: 15 });
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls += 1;
        return allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(calls).toBe(0);
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?', seeded.frameId)).toBe(15);
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels WHERE frame_id = ?', seeded.frameId)).toBe(0);
      const frame = frameRow(db, seeded.frameId);
      expect(frame.state).toBe('FAILED');
      expect(frame.error).toContain('15 次');
    } finally {
      db.close();
    }
  });

  it('gives a batch only two format retries and counts them into its five attempts', async () => {
    const dataDir = makeTempDir('lf-issue17-format-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 40, budgetPerTask: 100 });
    const seeded = seedFrame(db, dataDir, { objectCount: 2 });
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async () => {
        calls += 1;
        return { ok: true, text: 'not-json', tokens: 1, ms: 1 };
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(calls).toBe(3); // initial call + two format retries
      expect(count(db, 'SELECT COUNT(*) AS count FROM calls WHERE frame_id = ?', seeded.frameId)).toBe(3);
      expect(count(db, 'SELECT COUNT(*) AS count FROM labels WHERE frame_id = ?', seeded.frameId)).toBe(0);
      const frame = frameRow(db, seeded.frameId);
      expect(frame.state).toBe('FAILED');
      expect(frame.error).toContain('模型输出不合法');
    } finally {
      db.close();
    }
  });
  it('runs one frame\'s object batches serially even when visionConcurrency is 8', async () => {
    const dataDir = makeTempDir('lf-issue17-serial-');
    const db = openDatabase(dataDir);
    const settings = makeSettings(db, { objectsPerCall: 2, visionConcurrency: 8 });
    const seeded = seedFrame(db, dataDir, { objectCount: 6 });
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
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return allPresent(input.prompt);
      },
    };
    try {
      await makePipeline(db, settings, dataDir, vision).runUntilIdle();

      expect(calls).toBe(3);
      expect(peak).toBe(1);
      expect(labelNames(db, seeded.frameId).sort()).toEqual([...seeded.names].sort());
      expect(frameRow(db, seeded.frameId).state).toBe('JUDGED');
    } finally {
      db.close();
    }
  });
});

describe('issue #17: objectsPerCall settings', () => {
  it('defaults to 24 for legacy rows and accepts only integers from 1 to 300', () => {
    expect(defaultSettings().objectsPerCall).toBe(24);
    const legacy: Record<string, unknown> = { ...defaultSettings() };
    delete legacy.objectsPerCall;
    expect(parseSettings(legacy).objectsPerCall).toBe(24);

    const base = defaultSettings();
    expect(parseSettings({ ...base, objectsPerCall: 1 }).objectsPerCall).toBe(1);
    expect(parseSettings({ ...base, objectsPerCall: 300 }).objectsPerCall).toBe(300);
    for (const bad of [0, 301, 40.5]) {
      expect(() => parseSettings({ ...base, objectsPerCall: bad })).toThrow(SettingsError);
    }
  });

  it('rejects an invalid save, keeps the previous value and persists across a reopen', () => {
    const db = openDatabase(makeTempDir('lf-issue17-settings-'));
    try {
      new SettingsStore(db).update({ objectsPerCall: 255 });
      expect(new SettingsStore(db).load().objectsPerCall).toBe(255);

      expect(() => new SettingsStore(db).update({ objectsPerCall: 0 })).toThrow(SettingsError);
      expect(() => new SettingsStore(db).update({ objectsPerCall: 301 })).toThrow(SettingsError);
      expect(() => new SettingsStore(db).update({ objectsPerCall: 40.5 })).toThrow(SettingsError);
      expect(new SettingsStore(db).load().objectsPerCall).toBe(255);
    } finally {
      db.close();
    }
  });
});
