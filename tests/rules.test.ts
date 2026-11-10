import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRegion, parseSourceCsv } from '../src/csv.js';
import { frameCount, frameTimestampsMs, hammingHex, dhashFromGray, DHASH_DISTANCE_MAX } from '../src/dhash.js';
import { exceedsAttachmentLimits, fitAttachmentBox, halvedTarget, selectRequestImage } from '../src/imageFit.js';
import { judgeBatch, TaskPause } from '../src/judge.js';
import { csvCell, outcomeFor, parseModelOutput, VERDICT_DEFINITIONS, buildPrompt, chunkObjects } from '../src/prompt.js';
import { classifyFailure, createStreamFold, visionSessionId } from '../src/vision.js';
import { splitForFamily, familyIdFor, exportFileName } from '../src/export.js';
import type { VisionClient } from '../src/vision.js';

describe('frame plan', () => {
  it('uses a 2 second default, keeps one frame for a short video, and has no per-video cap', () => {
    expect(frameCount(0.4, 2)).toBe(1);
    expect(frameCount(5, 2)).toBe(2);
    expect(frameCount(7200, 2)).toBe(3600);
    expect(frameTimestampsMs(5, 2)).toEqual([1250, 3750]);
    expect(frameTimestampsMs(10, 1)).toEqual([5000]);
  });
});

describe('dHash', () => {
  it('is stable, identical for the same raster, and counts bit flips', () => {
    const width = 9;
    const height = 8;
    const flat = new Uint8Array(width * height).fill(40);
    expect(dhashFromGray(flat, width, height)).toBe('0000000000000000');
    const bright = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) bright[y * width + x] = x < 4 ? 220 : 10;
    }
    const hash = dhashFromGray(bright, width, height);
    expect(hash).toHaveLength(16);
    expect(hammingHex(hash, hash)).toBe(0);
    expect(hammingHex(hash, '0000000000000000')).toBeGreaterThan(0);
    expect(hammingHex('0000000000000001', '0000000000000000')).toBe(1);
    expect(DHASH_DISTANCE_MAX).toBe(16);
  });
});

describe('source csv', () => {
  it('keeps literal fields, requires region evidence, and accepts a BOM', () => {
    const table = parseSourceCsv('\uFEFFfile,url,author,license,region,region_evidence,family\nclip.mp4,http://example.test,作者,CC,CN,字幕,fam-1\n');
    const row = table.byKey.get('clip.mp4');
    expect(row).toMatchObject({ url: 'http://example.test', author: '作者', license: 'CC', region: 'CN', family: 'fam-1' });
    expect(normalizeRegion('CN', '')).toBe('UNKNOWN');
    expect(normalizeRegion('SEA', 'note')).toBe('SEA');
    expect(normalizeRegion('EU', 'note')).toBe('UNKNOWN');
  });
});

describe('model output', () => {
  const names = ['object-a', 'object-b'];

  it('rejects invalid JSON, missing names, and extra fields before any label exists', () => {
    expect(parseModelOutput('not json', names).ok).toBe(false);
    expect(parseModelOutput('{"objects":[]}', names).ok).toBe(false);
    const extra = parseModelOutput(
      JSON.stringify({
        objects: names.map((name) => ({ name, verdict: 'ABSENT', visibility: 'CLEAR', confidence: 1, reason: '没有', view: 'no' })),
      }),
      names,
    );
    expect(extra.ok).toBe(false);
  });

  it('maps TINY to not qualified and only an explicit ABSENT to csv 0', () => {
    expect(outcomeFor('PRESENT', 'CLEAR')).toBe('QUALIFIED');
    expect(outcomeFor('PRESENT', 'SMALL')).toBe('QUALIFIED');
    expect(outcomeFor('PRESENT', 'TINY')).toBe('NOT_QUALIFIED');
    expect(outcomeFor('PRESENT', 'OCCLUDED')).toBe('NOT_QUALIFIED');
    expect(outcomeFor('UNSURE', 'CLEAR')).toBe('UNSURE');
    expect(outcomeFor('ABSENT', 'CLEAR')).toBe('NOT_QUALIFIED');
    expect(csvCell({ verdict: 'PRESENT', outcome: 'QUALIFIED' })).toBe('1');
    expect(csvCell({ verdict: 'ABSENT', outcome: 'NOT_QUALIFIED' })).toBe('0');
    expect(csvCell({ verdict: 'PRESENT', outcome: 'NOT_QUALIFIED' })).toBe('');
    expect(csvCell(null)).toBe('');
  });

  it('keeps the section 7 definitions verbatim and batches above 8 objects', () => {
    const prompt = buildPrompt([{ name: 'object-a', aliases: {}, definition: '一个对象。' }]);
    expect(prompt).toContain(VERDICT_DEFINITIONS);
    expect(prompt).toContain('画面里能确认这个对象存在。');
    expect(prompt).not.toContain('object-b');
    expect(chunkObjects([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], [9]]);
  });
});

describe('judge retries', () => {
  function client(results: Array<Awaited<ReturnType<VisionClient['judge']>>>): {
    vision: VisionClient;
    calls: number;
    waits: number[];
  } {
    let calls = 0;
    const waits: number[] = [];
    return {
      get calls() {
        return calls;
      },
      waits,
      vision: {
        available: () => true,
        listImageModels: async () => [],
        judge: async () => {
          const next = results[calls];
          calls += 1;
          if (next === undefined) return { ok: false, kind: 'retryable', message: '没有更多结果' };
          return next;
        },
      },
    };
  }

  const objects = [{ name: 'object-a', aliases: {}, definition: '一个对象。' }];

  it('fails a frame after two invalid JSON retries and does not guess', async () => {
    const fake = client([
      { ok: true, text: 'nope', tokens: 1, ms: 1 },
      { ok: true, text: '{', tokens: 1, ms: 1 },
      { ok: true, text: '{"objects":[]}', tokens: 1, ms: 1 },
    ]);
    const result = await judgeBatch({
      vision: fake.vision,
      provider: 'p',
      model: 'm',
      objects,
      imagePath: '/tmp/frame.jpg',
      taskId: 'task-test',
      sleep: async (ms) => {
        fake.waits.push(ms);
      },
      beforeCall: () => undefined,
      onAttempt: () => undefined,
      credentialRetry: { used: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('format');
    expect(fake.calls).toBe(3);
    expect(fake.waits).toEqual([1000, 5000]);
  });

  it('pauses immediately on invalid credentials and exhausted quota', async () => {
    const credential = client([{ ok: false, kind: 'credential_invalid', message: '凭据无效' }]);
    await expect(
      judgeBatch({
        vision: credential.vision,
        provider: 'p',
        model: 'm',
        objects,
        imagePath: '/tmp/frame.jpg',
        taskId: 'task-test',
        sleep: async () => undefined,
        beforeCall: () => undefined,
        onAttempt: () => undefined,
        credentialRetry: { used: false },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CREDENTIAL' });
    expect(credential.calls).toBe(1);

    const quota = client([{ ok: false, kind: 'quota', message: '额度用尽' }]);
    await expect(
      judgeBatch({
        vision: quota.vision,
        provider: 'p',
        model: 'm',
        objects,
        imagePath: '/tmp/frame.jpg',
        taskId: 'task-test',
        sleep: async () => undefined,
        beforeCall: () => undefined,
        onAttempt: () => undefined,
        credentialRetry: { used: true },
      }),
    ).rejects.toBeInstanceOf(TaskPause);
    expect(quota.calls).toBe(1);
  });

  it('retries a missing credential once after 3 seconds, only for the first call of this process', async () => {
    const fake = client([
      { ok: false, kind: 'credential_missing', message: '缺凭据' },
      { ok: true, text: JSON.stringify({ objects: [{ name: 'object-a', verdict: 'ABSENT', visibility: 'CLEAR', confidence: 0.4, reason: '没有' }] }), tokens: 2, ms: 4 },
    ]);
    const waits: number[] = [];
    const result = await judgeBatch({
      vision: fake.vision,
      provider: 'p',
      model: 'm',
      objects,
      imagePath: '/tmp/frame.jpg',
      taskId: 'task-test',
      sleep: async (ms) => {
        waits.push(ms);
      },
      beforeCall: () => undefined,
      onAttempt: () => undefined,
      credentialRetry: { used: false },
    });
    expect(result.ok).toBe(true);
    expect(waits).toEqual([3000]);
    expect(fake.calls).toBe(2);
  });

  it('treats text followed by an error finish as a failed call', () => {
    const fold = createStreamFold();
    fold.push({ type: 'text-delta', text: '{"objects":[]}' });
    fold.push({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 2500 } } });
    const result = fold.result();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('retryable');
      expect(result.retryAfterMs).toBe(2500);
    }
    const invalid = classifyFailure({ code: 'AUTH', message: 'invalid api key', status: 401 });
    const quota = classifyFailure({ code: 'QUOTA', message: '额度用尽' });
    expect(invalid.ok).toBe(false);
    expect(quota.ok).toBe(false);
    if (!invalid.ok) expect(invalid.kind).toBe('credential_invalid');
    if (!quota.ok) expect(quota.kind).toBe('quota');
  });
});

describe('classifyFailure', () => {
  it('treats only real credential gaps as credential_missing', () => {
    const session = classifyFailure({
      code: 'MissingSessionID',
      message: 'Request is missing x-opencode-session and cannot be routed efficiently.',
      status: 400,
    });
    expect(session.ok).toBe(false);
    if (!session.ok) expect(session.kind).toBe('retryable');

    const header = classifyFailure({
      message: 'Request is missing x-opencode-session',
      status: 400,
    });
    expect(header.ok).toBe(false);
    if (!header.ok) expect(header.kind).toBe('retryable');

    for (const failure of [
      { code: 'NO_CREDENTIAL', message: 'no_api_key' },
      { code: 'MISSING_CREDENTIAL', message: 'api key not set' },
      { message: '缺凭据' },
      { message: '没有凭据' },
      { message: '凭据未配置' },
    ] as const) {
      const result = classifyFailure(failure);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('credential_missing');
    }
  });

  it('derives a stable session id from the task id', () => {
    const taskId = 'a962888a-601c-4d36-86d1-3b50e820e696';
    expect(visionSessionId(taskId)).toBe(`local-frames:${taskId}`);
    expect(visionSessionId(taskId)).toBe(visionSessionId(taskId));
  });
});

describe('image limits', () => {
  it('shrinks past the attachment caps and halves once when the model target is missed', async () => {
    expect(exceedsAttachmentLimits(9000, 1000, 10)).toBe(true);
    const fitted = fitAttachmentBox(9000, 1000, 10);
    expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(8192);
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(64_000_000);
    const huge = fitAttachmentBox(4000, 4000, 40 * 1024 * 1024);
    expect(huge.width).toBeLessThan(4000);

    const reads: Array<{ width: number; height: number }> = [];
    const selected = await selectRequestImage({ width: 800, height: 600, maxBytes: 100 }, async (target) => {
      reads.push(target);
      if (reads.length === 1) return { bytes: 500, width: target.width, height: target.height, withinMaxBytes: false };
      return { bytes: 40, width: target.width, height: target.height, withinMaxBytes: true };
    });
    expect(selected.ok).toBe(true);
    expect(reads[1]).toEqual(halvedTarget({ width: 800, height: 600, maxBytes: 100 }));
    const failed = await selectRequestImage({ width: 800, height: 600, maxBytes: 10 }, async () => ({
      bytes: 50,
      width: 10,
      height: 10,
      withinMaxBytes: false,
    }));
    expect(failed.ok).toBe(false);
  });
});

describe('export identity', () => {
  it('uses the file hash unless the csv family is present, and keeps one family on one side', () => {
    expect(familyIdFor('', 'abc')).toBe('abc');
    expect(familyIdFor(' fam ', 'abc')).toBe('fam');
    const digest = createHash('sha256').update('abc').digest('hex');
    const expected = Number.parseInt(digest.slice(0, 2), 16) < 205 ? 'train' : 'val';
    expect(splitForFamily('abc')).toBe(expected);
    const first = splitForFamily('abc');
    expect(splitForFamily('abc')).toBe(first);
    expect(['train', 'val']).toContain(first);
    const used = new Set<string>();
    expect(exportFileName('My Clip!!.mp4', 'frame-1', used)).toBe('MyClip-frame-1.jpg');
    expect(exportFileName('My Clip!!.mp4', 'frame-1', used)).toBe('MyClip-frame-1-2.jpg');
  });
});

describe('forbidden leftovers', () => {
  it('does not spawn processes, move user videos, or carry the old project', () => {
    const files = readdirSync(join(process.cwd(), 'src')).filter((name) => name.endsWith('.ts'));
    const source = files.map((name) => readFileSync(join(process.cwd(), 'src', name), 'utf8')).join('\n');
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/renameSync/);
    expect(source).not.toMatch(/aerialframes/);
    expect(source).not.toMatch(/yt-dlp/);
    expect(source).not.toMatch(/worker_threads/);
    expect(source).not.toMatch(/trialJudge|试判/);
  });
});
