import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { dhashFromGray, hammingHex } from '../src/dhash.js';
import { exportTask, splitForFamily } from '../src/export.js';
import { createFfmpegMedia, type MediaClient } from '../src/media.js';
import { controlTask, Pipeline } from '../src/pipeline.js';
import { retryTaskFailures } from '../src/retry.js';
import { SettingsStore } from '../src/settings.js';
import { createTools } from '../src/tool.js';
import { buildStatus } from '../src/status.js';
import { EnvironmentChecker } from '../src/versions.js';
import type { VisionClient, VisionResult } from '../src/vision.js';
import { fakeExec, healthySubprocess, makeTempDir, writeFixtureFile } from './helpers.js';
import { hostSubprocess, runChecked } from './host-subprocess.js';

// Fixtures live under the OS temp dir; keep capacity checks independent of the host's free disk.
vi.mock('../src/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/disk.js')>();
  return { ...actual, freeDiskGb: () => 100 };
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function scriptedVision(script: (prompt: string, calls: number) => VisionResult): { vision: VisionClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    vision: {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        calls.push(input.prompt);
        return script(input.prompt, calls.length);
      },
    },
  };
}

function qualified(name: string): VisionResult {
  return {
    ok: true,
    text: JSON.stringify({
      objects: [{ name, verdict: 'PRESENT', visibility: 'CLEAR', confidence: 0.9, reason: '看清了' }],
    }),
    tokens: 4,
    ms: 2,
  };
}

describe('ffmpeg frames, dedup, and unchanged originals', () => {
  it.skipIf(process.platform === 'win32')('extracts, deduplicates across videos, labels only unique frames, and exports a stable split', async () => {
    const dataDir = makeTempDir('lf-data-');
    const root = makeTempDir('lf-videos-');
    const hidden = join(root, 'skip-link');
    mkdirSync(hidden);
    const outside = makeTempDir('lf-outside-');
    symlinkSync(outside, join(root, 'linked-dir'));
    writeFixtureFile(join(outside, 'escape.mp4'), 'nope');

    await runChecked(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=1:duration=1', '-frames:v', '1', join(root, 'still.png')]);
    await runChecked(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', join(root, 'still.png'), '-q:v', '8', join(root, 'still.jpg')]);
    await runChecked(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'smptebars=size=160x120:rate=1:duration=1', '-frames:v', '1', join(root, 'bars.png')]);
    await runChecked(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', join(root, 'still.png'), '-t', '5', '-r', '5', '-pix_fmt', 'yuv420p', join(root, 'a.mp4')]);
    await runChecked(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', join(root, 'still.jpg'), '-t', '3', '-r', '5', '-pix_fmt', 'yuv420p', join(root, 'b.mp4')]);
    await runChecked(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', join(root, 'bars.png'), '-t', '3', '-r', '5', '-pix_fmt', 'yuv420p', join(root, 'c.mp4')]);
    await runChecked(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x2255aa:s=160x120:d=0.4', '-pix_fmt', 'yuv420p', join(root, 'short.mp4')]);
    writeFixtureFile(join(root, 'bad.mp4'), 'this is not a video');
    writeFixtureFile(
      join(root, 'metadata.csv'),
      'file,url,author,license,region,region_evidence,family\na.mp4,http://example.test/a,作者,CC0,CN,文件名,family-a\n',
    );

    const media = createFfmpegMedia(hostSubprocess(), dataDir);
    const grayA = await media.decodeGray(join(root, 'still.png'), join(dataDir, 'a.pgm'));
    const grayB = await media.decodeGray(join(root, 'still.jpg'), join(dataDir, 'b.pgm'));
    const grayC = await media.decodeGray(join(root, 'bars.png'), join(dataDir, 'c.pgm'));
    expect(grayA.ok && grayB.ok && grayC.ok).toBe(true);
    if (!grayA.ok || !grayB.ok || !grayC.ok) return;
    const hashA = dhashFromGray(grayA.raster.pixels, grayA.raster.width, grayA.raster.height);
    const hashB = dhashFromGray(grayB.raster.pixels, grayB.raster.width, grayB.raster.height);
    const hashC = dhashFromGray(grayC.raster.pixels, grayC.raster.width, grayC.raster.height);
    expect(hammingHex(hashA, hashB)).toBeLessThanOrEqual(16);
    expect(hammingHex(hashA, hashC)).toBeGreaterThan(16);

    const before = {
      a: sha256(join(root, 'a.mp4')),
      b: sha256(join(root, 'b.mp4')),
      c: sha256(join(root, 'c.mp4')),
      short: sha256(join(root, 'short.mp4')),
      bad: sha256(join(root, 'bad.mp4')),
    };
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({
      allowRoots: [root],
      model: { provider: 'example', model: 'vision' },
      frameIntervalSeconds: 2,
    });
    const vision = scriptedVision((prompt) => {
      const name = /"name":"([^"]+)"/u.exec(prompt)?.[1] ?? 'object-a';
      return qualified(name);
    });
    const pipeline = new Pipeline({
      db,
      settings,
      dataDir,
      media,
      vision: vision.vision,
      sleep: async () => undefined,
      // Fixtures live under the OS temp dir; the spec's free-disk pause is not under test here.
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
    const tools = createTools({
      db,
      settings,
      dataDir,
      pipeline,
      environment,
      log: () => undefined,
      buildStatus: (fresh) =>
        buildStatus({ db, settings, environment, dataDir, freshEnvironment: fresh, pluginVersion: '0.1.0' }),
    });
    const tool = (name: string) => {
      const found = tools.find((entry) => entry.name === name);
      if (found === undefined) throw new Error(name);
      return found;
    };
    try {
      const target = (await tool('lf_target_add').execute(
        { name: 'object-a', aliases: { en: ['thing'] }, definition: '一个画面中的物体。' },
        fakeExec(),
      )) as { status: string; data: { target_id?: string } };
      expect(target.status).toBe('OK');
      const started = (await tool('lf_collect_start').execute(
        { paths: [join(root, 'a.mp4'), join(root, 'b.mp4'), join(root, 'c.mp4'), join(root, 'short.mp4'), join(root, 'bad.mp4')] },
        fakeExec(),
      )) as { status: string; message: string; data: { task_id?: string } };
      expect(started.status).toBe('OK');
      const taskId = started.data.task_id;
      expect(typeof taskId).toBe('string');
      await pipeline.runUntilIdle();

      expect(sha256(join(root, 'a.mp4'))).toBe(before.a);
      expect(sha256(join(root, 'b.mp4'))).toBe(before.b);
      expect(sha256(join(root, 'c.mp4'))).toBe(before.c);
      expect(sha256(join(root, 'short.mp4'))).toBe(before.short);
      expect(sha256(join(root, 'bad.mp4'))).toBe(before.bad);
      expect(existsSync(join(root, 'a.mp4'))).toBe(true);

      const bad = db.raw.prepare("SELECT state, error_code FROM items WHERE title = 'bad.mp4'").get() as {
        state?: string;
        error_code?: string;
      };
      expect(bad).toMatchObject({ state: 'ERROR', error_code: 'PROBE_FAILED' });
      const labelsForBad = db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM labels JOIN frames ON frames.frame_id = labels.frame_id JOIN items ON items.item_id = frames.item_id WHERE items.title = 'bad.mp4'",
        )
        .get() as { count?: number };
      expect(labelsForBad.count).toBe(0);

      const duplicates = db.raw.prepare("SELECT COUNT(*) AS count FROM frames WHERE state = 'DUPLICATE'").get() as { count?: number };
      expect((duplicates.count ?? 0) >= 2).toBe(true);
      const dupFiles = db.raw.prepare("SELECT path FROM frames WHERE state = 'DUPLICATE'").all() as Array<{ path: string | null }>;
      expect(dupFiles.every((row) => row.path === null)).toBe(true);
      const calls = db.raw.prepare('SELECT COUNT(*) AS count FROM calls WHERE ok = 1').get() as { count?: number };
      const judged = db.raw.prepare("SELECT COUNT(*) AS count FROM frames WHERE state = 'JUDGED'").get() as { count?: number };
      expect(calls.count).toBe(judged.count);
      expect((calls.count ?? 0) < (db.raw.prepare('SELECT COUNT(*) AS count FROM frames').get() as { count: number }).count).toBe(true);

      const b = db.raw.prepare("SELECT state FROM items WHERE title = 'b.mp4'").get() as { state?: string };
      expect(b.state).toBe('DONE');
      const bLabels = db.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM labels JOIN frames ON frames.frame_id = labels.frame_id JOIN items ON items.item_id = frames.item_id WHERE items.title = 'b.mp4'",
        )
        .get() as { count?: number };
      expect(bLabels.count).toBe(0);

      if (typeof taskId !== 'string') throw new Error('missing task');
      const exported = exportTask(db, dataDir, taskId);
      expect(exported.images).toBeGreaterThan(0);
      expect(exported.duplicatesSkipped).toBe(duplicates.count);
      const labels = readFileSync(join(exported.directory, 'labels.csv'), 'utf8').trim().split('\n');
      const sources = readFileSync(join(exported.directory, 'sources.csv'), 'utf8').trim().split('\n');
      expect(labels[0]).toBe('file_name,split,family_id,object-a');
      expect(sources[0]).toContain('local_path,file_sha256');
      const readme = readFileSync(join(exported.directory, 'README.txt'), 'utf8');
      expect(readme).toContain('素材为用户预先下载的本地文件，用户确认可用');
      expect(readme).toContain('license_raw 照实记录');
      expect(readme).toContain('region 为 UNKNOWN 表示没有元数据证据');
      expect(readme).toContain('汉明距离≤16');
      const imageNames = readdirSync(join(exported.directory, 'images'));
      expect(imageNames.length).toBe(exported.images);
      const body = labels.slice(1);
      const sourceBody = sources.slice(1);
      expect(body.length).toBe(sourceBody.length);
      const families = new Map<string, string>();
      for (const line of body) {
        const [fileName, split, family, cell] = line.split(',');
        expect(fileName).toMatch(/\.jpg$/u);
        expect(imageNames).toContain(fileName);
        expect(cell).toBe('1');
        const previous = families.get(family ?? '');
        if (previous === undefined) families.set(family ?? '', split ?? '');
        else expect(split).toBe(previous);
        expect(split).toBe(splitForFamily(family ?? ''));
      }
      expect(sourceBody.some((line) => line.includes('http://example.test/a'))).toBe(true);
      expect(sourceBody.some((line) => line.includes('family-a'))).toBe(true);
      expect(sourceBody.join('\n')).not.toMatch(/youtube|bilibili|channel/iu);
      const second = exportTask(db, dataDir, taskId, new Date(Date.now() + 1000));
      const secondLabels = readFileSync(join(second.directory, 'labels.csv'), 'utf8');
      const splits = new Map<string, string>();
      for (const line of secondLabels.trim().split('\n').slice(1)) {
        const cells = line.split(',');
        splits.set(cells[2] ?? '', cells[1] ?? '');
      }
      for (const [family, split] of families) expect(splits.get(family)).toBe(split);

      const customRoot = makeTempDir('lf-export-custom-');
      const custom = exportTask(db, dataDir, taskId, new Date(Date.now() + 2000), customRoot);
      expect(custom.directory.startsWith(`${customRoot}${sep}`)).toBe(true);
      expect(custom.images).toBe(exported.images);
      expect(readdirSync(join(custom.directory, 'images')).length).toBe(custom.images);
      expect(readFileSync(join(custom.directory, 'labels.csv'), 'utf8')).toContain('file_name,split,family_id');
      expect(existsSync(join(dataDir, 'exports'))).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);
});

describe('restart and failure accounting', () => {
  it('does not double-count frames when a run stops and starts again', async () => {
    const dataDir = makeTempDir('lf-restart-');
    const root = makeTempDir('lf-restart-root-');
    const file = writeFixtureFile(join(root, 'clip.mp4'), 'not-a-real-video-but-the-media-is-fake');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ allowRoots: [root], model: { provider: 'example', model: 'vision' }, frameIntervalSeconds: 2 });
    let extracts = 0;
    const media: MediaClient = {
      async probeDuration() {
        return { ok: true, duration: 5 };
      },
      async extractFrame(_file, _seconds, dest) {
        extracts += 1;
        if (extracts === 2) return { ok: false, error: '中断', timedOut: false };
        writeFixtureFile(dest, 'jpeg-bytes');
        return { ok: true };
      },
      async decodeGray() {
        const pixels = new Uint8Array(32 * 32);
        pixels[0] = extracts;
        return { ok: true, raster: { width: 32, height: 32, pixels } };
      },
      async shrinkJpeg() {
        return { ok: true };
      },
    };
    const vision = scriptedVision(() => qualified('object-a'));
    const first = new Pipeline({ db, settings, dataDir, media, vision: vision.vision, sleep: async () => undefined, minFreeGb: 0 });
    const now = new Date().toISOString();
    const taskId = 'task-restart';
    db.raw
      .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        taskId,
        JSON.stringify({
          targetIds: [],
          frameIntervalSeconds: 2,
          budgetPerTask: 3000,
          model: { provider: 'example', model: 'vision' },
        }),
        '{}',
        'RUNNING',
        now,
        now,
      );
    db.raw
      .prepare(
        'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      )
      .run('tgt-1', 'object-a', '{}', '一个物体。', now, now);
    db.raw
      .prepare('UPDATE tasks SET spec_json = ? WHERE task_id = ?')
      .run(
        JSON.stringify({
          targetIds: ['tgt-1'],
          frameIntervalSeconds: 2,
          budgetPerTask: 3000,
          model: { provider: 'example', model: 'vision' },
        }),
        taskId,
      );
    db.raw
      .prepare(
        `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'NEW', ?, ?)`,
      )
      .run('item-1', taskId, file, 'hash', statSync(file).size, 'clip.mp4', now, now);
    try {
      await first.runUntilIdle();
      const afterStop = db.raw.prepare('SELECT COUNT(*) AS count FROM frames').get() as { count?: number };
      const second = new Pipeline({ db, settings, dataDir, media, vision: vision.vision, sleep: async () => undefined, minFreeGb: 0 });
      db.raw.prepare("UPDATE tasks SET status = 'RUNNING' WHERE task_id = ?").run(taskId);
      const item = db.raw.prepare('SELECT state FROM items WHERE item_id = ?').get('item-1') as { state?: string };
      if (item.state === 'ERROR') {
        db.raw.prepare("UPDATE items SET state = 'PROBED', error_code = NULL WHERE item_id = ?").run('item-1');
      }
      await second.runUntilIdle();
      const after = db.raw.prepare('SELECT COUNT(*) AS count FROM frames').get() as { count?: number };
      const stamps = db.raw.prepare('SELECT t_ms, state FROM frames ORDER BY t_ms').all() as Array<{ t_ms: number; state: string }>;
      expect(new Set(stamps.map((row) => row.t_ms)).size).toBe(stamps.length);
      expect((after.count ?? 0) >= (afterStop.count ?? 0)).toBe(true);
      expect(stamps.map((row) => row.t_ms)).toEqual([1250, 3750]);
    } finally {
      db.close();
    }
  });

  it('pauses after repeated invalid model output and never writes QUALIFIED without a successful call', async () => {
    const dataDir = makeTempDir('lf-format-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, budgetPerTask: 100 });
    const now = new Date().toISOString();
    db.raw
      .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task',
        JSON.stringify({ targetIds: ['tgt'], frameIntervalSeconds: 2, budgetPerTask: 100, model: { provider: 'example', model: 'vision' } }),
        '{}',
        'RUNNING',
        now,
        now,
      );
    db.raw
      .prepare('INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run('tgt', 'object-a', '{}', '一个物体。', now, now);
    db.raw
      .prepare(
        `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
         VALUES ('item', 'task', '/tmp/video.mp4', 'hash', 10, 'video.mp4', '{"duration":2}', 'FRAMED', ?, ?)`,
      )
      .run(now, now);
    for (let index = 0; index < 5; index += 1) {
      const path = join(dataDir, 'frames', 'task', `frame-${index}.jpg`);
      writeFixtureFile(path, `frame-${index}`);
      db.raw
        .prepare(
          `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
           VALUES (?, 'item', ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(`frame-${index}`, 1000 + index, path, `0123456789abcde${index}`, now, now);
    }
    const media: MediaClient = {
      probeDuration: async () => ({ ok: false, error: 'unused' }),
      extractFrame: async () => ({ ok: false, error: 'unused', timedOut: false }),
      decodeGray: async () => ({ ok: false, error: 'unused' }),
      shrinkJpeg: async () => ({ ok: false, error: 'unused' }),
    };
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async () => {
        calls += 1;
        return { ok: true, text: 'not-json', tokens: 1, ms: 1 };
      },
    };
    const pipeline = new Pipeline({ db, settings, dataDir, media, vision, sleep: async () => undefined, minFreeGb: 0 });
    try {
      await pipeline.runUntilIdle();
      const task = db.raw.prepare('SELECT status, progress_json FROM tasks').get() as { status: string; progress_json: string };
      expect(task.status).toBe('PAUSED');
      expect(task.progress_json).toContain('MODEL_OUTPUT');
      const labels = db.raw.prepare("SELECT COUNT(*) AS count FROM labels WHERE outcome = 'QUALIFIED'").get() as { count?: number };
      expect(labels.count).toBe(0);
      expect(existsSync(join(dataDir, 'frames', 'task', 'frame-4.jpg'))).toBe(false);
      expect(calls).toBe(15);
    } finally {
      db.close();
    }
  });

  it('judges all ten task objects in one model call and writes a verdict for each', async () => {
    const dataDir = makeTempDir('lf-batch-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, budgetPerTask: 20 });
    const now = new Date().toISOString();
    const targetIds: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const id = `tgt-${index}`;
      targetIds.push(id);
      db.raw
        .prepare('INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(id, `object-${index}`, '{}', '一个物体。', now, now);
    }
    db.raw
      .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task',
        JSON.stringify({ targetIds, frameIntervalSeconds: 2, budgetPerTask: 20, model: { provider: 'example', model: 'vision' } }),
        '{}',
        'RUNNING',
        now,
        now,
      );
    db.raw
      .prepare(
        `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
         VALUES ('item', 'task', '/tmp/video.mp4', 'hash', 10, 'video.mp4', '{"duration":2}', 'FRAMED', ?, ?)`,
      )
      .run(now, now);
    const framePath = join(dataDir, 'frames', 'task', 'frame.jpg');
    writeFixtureFile(framePath, 'frame');
    db.raw
      .prepare(
        `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
         VALUES ('frame', 'item', 1000, ?, '0123456789abcdef', 'PENDING', ?, ?)`,
      )
      .run(framePath, now, now);
    const prompts: string[] = [];
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async (input) => {
        prompts.push(input.prompt);
        const table = input.prompt.split('对象表：')[1] ?? '';
        const names = [...table.matchAll(/"name":"([^"]+)"/gu)].map((match) => match[1] ?? '');
        return {
          ok: true,
          text: JSON.stringify({
            objects: names.map((name) => ({ name, verdict: 'PRESENT', visibility: 'SMALL', confidence: 0.8, reason: '轮廓完整' })),
          }),
          tokens: 3,
          ms: 1,
        };
      },
    };
    const media: MediaClient = {
      probeDuration: async () => ({ ok: false, error: 'unused' }),
      extractFrame: async () => ({ ok: false, error: 'unused', timedOut: false }),
      decodeGray: async () => ({ ok: false, error: 'unused' }),
      shrinkJpeg: async () => ({ ok: false, error: 'unused' }),
    };
    const pipeline = new Pipeline({ db, settings, dataDir, media, vision, sleep: async () => undefined, minFreeGb: 0 });
    try {
      await pipeline.runUntilIdle();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.split('对象表：')[1]?.match(/"name":"/gu)?.length).toBe(10);
      const labels = db.raw.prepare('SELECT COUNT(*) AS count FROM labels WHERE outcome = ?').get('QUALIFIED') as { count?: number };
      expect(labels.count).toBe(10);
      const frame = db.raw.prepare('SELECT state FROM frames WHERE frame_id = ?').get('frame') as { state?: string };
      expect(frame.state).toBe('JUDGED');
    } finally {
      db.close();
    }
  });
});

describe('parallel vision calls', () => {
  const unusedMedia: MediaClient = {
    probeDuration: async () => ({ ok: false, error: 'unused' }),
    extractFrame: async () => ({ ok: false, error: 'unused', timedOut: false }),
    decodeGray: async () => ({ ok: false, error: 'unused' }),
    shrinkJpeg: async () => ({ ok: false, error: 'unused' }),
  };

  function seedJudgingTask(
    db: ReturnType<typeof openDatabase>,
    dataDir: string,
    frameCount: number,
  ): { taskId: string; frameIds: string[] } {
    const now = new Date().toISOString();
    db.raw
      .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'task',
        JSON.stringify({ targetIds: ['tgt'], frameIntervalSeconds: 2, budgetPerTask: 3000, model: { provider: 'example', model: 'vision' } }),
        '{}',
        'RUNNING',
        now,
        now,
      );
    db.raw
      .prepare('INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run('tgt', 'object-a', '{}', '一个物体。', now, now);
    db.raw
      .prepare(
        `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, probe_json, state, created_at, updated_at)
         VALUES ('item', 'task', '/tmp/video.mp4', 'hash', 10, 'video.mp4', '{"duration":2}', 'FRAMED', ?, ?)`,
      )
      .run(now, now);
    const frameIds: string[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const frameId = `frame-${index}`;
      frameIds.push(frameId);
      const path = join(dataDir, 'frames', 'task', `${frameId}.jpg`);
      writeFixtureFile(path, frameId);
      db.raw
        .prepare(
          `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
           VALUES (?, 'item', ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(frameId, 1000 + index, path, `0123456789abcde${index}`, now, now);
    }
    return { taskId: 'task', frameIds };
  }

  function judgeAll(objects: Array<{ name: string }>) {
    return {
      ok: true as const,
      text: JSON.stringify({
        objects: objects.map((object) => ({
          name: object.name,
          verdict: 'PRESENT',
          visibility: 'SMALL',
          confidence: 0.8,
          reason: '轮廓完整',
        })),
      }),
      tokens: 3,
      ms: 1,
    };
  }

  it('keeps at most visionConcurrency calls in flight and actually runs them in parallel', async () => {
    const dataDir = makeTempDir('lf-concurrency-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, visionConcurrency: 2 });
    seedJudgingTask(db, dataDir, 4);
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async () => {
        calls += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return judgeAll([{ name: 'object-a' }]);
      },
    };
    const pipeline = new Pipeline({ db, settings, dataDir, media: unusedMedia, vision, sleep: async () => undefined, minFreeGb: 0 });
    try {
      await pipeline.runUntilIdle();
      expect(peak).toBe(2);
      expect(calls).toBe(4);
      const judged = db.raw.prepare("SELECT COUNT(*) AS count FROM frames WHERE state = 'JUDGED'").get() as { count?: number };
      expect(judged.count).toBe(4);
      const labels = db.raw.prepare('SELECT COUNT(*) AS count FROM labels').get() as { count?: number };
      expect(labels.count).toBe(4);
      const rows = db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count?: number };
      expect(rows.count).toBe(4);
      const item = db.raw.prepare("SELECT state FROM items WHERE item_id = 'item'").get() as { state?: string };
      expect(item.state).toBe('DONE');
    } finally {
      db.close();
    }
  });

  it('runs one call at a time when visionConcurrency is 1', async () => {
    const dataDir = makeTempDir('lf-serial-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, visionConcurrency: 1 });
    seedJudgingTask(db, dataDir, 3);
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async () => {
        calls += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return judgeAll([{ name: 'object-a' }]);
      },
    };
    const pipeline = new Pipeline({ db, settings, dataDir, media: unusedMedia, vision, sleep: async () => undefined, minFreeGb: 0 });
    try {
      await pipeline.runUntilIdle();
      expect(peak).toBe(1);
      expect(calls).toBe(3);
      const judged = db.raw.prepare("SELECT COUNT(*) AS count FROM frames WHERE state = 'JUDGED'").get() as { count?: number };
      expect(judged.count).toBe(3);
    } finally {
      db.close();
    }
  });

  it('caps one frame at five automatic attempts across batch boundaries and restarts, then a manual retry recovers it', async () => {
    const dataDir = makeTempDir('lf-retry-cap-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, visionConcurrency: 1, budgetPerTask: 3 });
    seedJudgingTask(db, dataDir, 1);
    let visionCalls = 0;
    let failing = true;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async () => {
        visionCalls += 1;
        if (failing) return { ok: false, kind: 'retryable', message: 'HTTP 404', retryAfterMs: 1 };
        return judgeAll([{ name: 'object-a' }]);
      },
    };
    const media: MediaClient = {
      probeDuration: async () => ({ ok: true, duration: 2 }),
      extractFrame: async (_file, _seconds, dest) => {
        writeFixtureFile(dest, 'jpeg-bytes');
        return { ok: true };
      },
      decodeGray: async () => {
        const pixels = new Uint8Array(32 * 32);
        for (let index = 0; index < pixels.length; index += 1) pixels[index] = index % 251;
        return { ok: true, raster: { width: 32, height: 32, pixels } };
      },
      shrinkJpeg: async () => ({ ok: true }),
    };
    const makePipeline = () =>
      new Pipeline({ db, settings, dataDir, media, vision, sleep: async () => undefined, minFreeGb: 0 });
    try {
      const first = makePipeline();
      await first.runUntilIdle();
      let task = db.raw.prepare('SELECT status, progress_json FROM tasks WHERE task_id = ?').get('task') as {
        status: string;
        progress_json: string;
      };
      expect(task.status).toBe('PAUSED');
      expect(task.progress_json).toContain('BUDGET');
      let calls = db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count?: number };
      expect(calls.count).toBe(3);
      expect(visionCalls).toBe(3);
      let frame = db.raw.prepare("SELECT state, path FROM frames WHERE frame_id = 'frame-0'").get() as {
        state?: string;
        path?: string | null;
        error?: string | null;
      };
      expect(frame.state).toBe('PENDING');

      // A second process/batch must continue from the persisted count, not restart at zero.
      settings.update({ budgetPerTask: 7 });
      expect(controlTask(db, dataDir, 'task', 'resume').ok).toBe(true);
      const second = makePipeline();
      await second.runUntilIdle();
      task = db.raw.prepare('SELECT status, progress_json FROM tasks WHERE task_id = ?').get('task') as {
        status: string;
        progress_json: string;
      };
      expect(task.status).toBe('DONE');
      expect(visionCalls).toBe(5);
      calls = db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count?: number };
      expect(calls.count).toBe(5);
      frame = db.raw.prepare("SELECT state, path, error FROM frames WHERE frame_id = 'frame-0'").get() as {
        state?: string;
        path?: string | null;
        error?: string | null;
      };
      expect(frame.state).toBe('FAILED');
      expect(frame.path).toBeNull();
      expect(frame.error).toContain('累计 5 次');

      // A finished task is not selected again, so the capped frame stays at five calls.
      await second.runUntilIdle();
      expect(visionCalls).toBe(5);

      // A manual retry drops the failed frame but keeps its calls: the spent
      // budget and call statistics survive, while the re-extracted frame gets a
      // fresh frame id and therefore a fresh five-attempt batch.
      const retried = retryTaskFailures(db, dataDir, 'task', { frameIds: ['frame-0'] });
      expect(retried.frames_retried).toEqual(['frame-0']);
      calls = db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count?: number };
      expect(calls.count).toBe(5);
      const item = db.raw.prepare("SELECT state FROM items WHERE item_id = 'item'").get() as { state?: string };
      expect(item.state).toBe('PROBED');

      failing = false;
      await makePipeline().runUntilIdle();
      const finished = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task') as { status: string };
      expect(finished.status).toBe('DONE');
      expect(visionCalls).toBe(6);
      const oldFrame = db.raw.prepare("SELECT state, path FROM frames WHERE frame_id = 'frame-0'").get();
      expect(oldFrame).toBeUndefined();
      const recovered = db.raw.prepare('SELECT frame_id, state FROM frames').all() as Array<{ frame_id: string; state: string }>;
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.frame_id).not.toBe('frame-0');
      expect(recovered[0]?.state).toBe('JUDGED');
      calls = db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count?: number };
      expect(calls.count).toBe(6);
    } finally {
      db.close();
    }
  });

  it('never spends more call rows than the budget while calls run in parallel', async () => {
    const dataDir = makeTempDir('lf-concurrency-budget-');
    const db = openDatabase(dataDir);
    const settings = new SettingsStore(db);
    settings.update({ model: { provider: 'example', model: 'vision' }, visionConcurrency: 2, budgetPerTask: 3 });
    seedJudgingTask(db, dataDir, 4);
    let calls = 0;
    const vision: VisionClient = {
      available: () => true,
      listImageModels: async () => [],
      judge: async () => {
        calls += 1;
        return judgeAll([{ name: 'object-a' }]);
      },
    };
    const pipeline = new Pipeline({ db, settings, dataDir, media: unusedMedia, vision, sleep: async () => undefined, minFreeGb: 0 });
    try {
      await pipeline.runUntilIdle();
      const task = db.raw.prepare('SELECT status, progress_json FROM tasks').get() as { status: string; progress_json: string };
      expect(task.status).toBe('PAUSED');
      expect(task.progress_json).toContain('BUDGET');
      const rows = db.raw.prepare('SELECT COUNT(*) AS count FROM calls').get() as { count?: number };
      expect(rows.count).toBe(3);
      expect(calls).toBe(3);
    } finally {
      db.close();
    }
  });
});
