import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { LocalFramesDatabase } from '../src/db.js';

export interface SeededFrame {
  frameId: string;
  path: string;
  content: string;
}

export interface SeededExport {
  taskId: string;
  targetA: string;
  targetB: string;
  frames: SeededFrame[];
}

let seedCounter = 0;

/**
 * Insert one finished task with two objects and four frames directly into the
 * plugin database. Frames are already extracted and judged, so export tests
 * never touch ffmpeg or the vision model.
 *
 * f1: A+B qualified; f2: A qualified only; f3: B qualified only;
 * f4: no object qualified, so it must not be exported.
 */
export function seedExportTask(db: LocalFramesDatabase, dataDir: string): SeededExport {
  seedCounter += 1;
  const at = '2026-01-01T00:00:00.000Z';
  const targetA = 'target-a';
  const targetB = 'target-b';
  db.raw
    .prepare(
      'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    )
    .run(targetA, 'object-a', '{}', '一个画面中的物体。', at, at);
  db.raw
    .prepare(
      'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    )
    .run(targetB, 'object-b', '{}', '另一个画面中的物体。', at, at);

  const taskId = `task-export-${seedCounter}`;
  const spec = {
    targetIds: [targetA, targetB],
    frameIntervalSeconds: 2,
    budgetPerTask: 3000,
    model: { provider: 'example', model: 'vision' },
  };
  db.raw
    .prepare(
      'INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(taskId, JSON.stringify(spec), '{}', 'DONE', at, at);

  const itemId = `item-${taskId}`;
  const videoPath = join(dataDir, 'sources', `clip-${seedCounter}.mp4`);
  db.raw
    .prepare(
      `INSERT INTO items (item_id, task_id, local_path, file_sha256, file_bytes, title, author, license_raw,
                          region, region_evidence, probe_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DONE', ?, ?)`,
    )
    .run(
      itemId,
      taskId,
      videoPath,
      'a'.repeat(64),
      10,
      'clip.mp4',
      '作者',
      'CC0',
      'CN',
      '文件名',
      JSON.stringify({ duration: 10, source: { url: 'http://example.test/clip', family: 'family-a' } }),
      at,
      at,
    );

  const framesDir = join(dataDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const frames: SeededFrame[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const frameId = `frame-${seedCounter}-${index}`;
    const path = join(framesDir, `${frameId}.jpg`);
    const content = `JPEG-${frameId}`;
    writeFileSync(path, content);
    frames.push({ frameId, path, content });
    db.raw
      .prepare(
        `INSERT INTO frames (frame_id, item_id, t_ms, path, dhash, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, '0000000000000000', 'JUDGED', ?, ?)`,
      )
      .run(frameId, itemId, index * 1000, path, at, at);
    db.raw
      .prepare(
        'INSERT INTO calls (call_id, task_id, frame_id, model, ms, tokens, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      )
      .run(`call-${frameId}`, taskId, frameId, 'example/vision', 2, 4, at);
  }

  const labels: Array<[string, string, string, string, string]> = [
    [frames[0]!.frameId, targetA, 'PRESENT', 'CLEAR', 'QUALIFIED'],
    [frames[0]!.frameId, targetB, 'PRESENT', 'CLEAR', 'QUALIFIED'],
    [frames[1]!.frameId, targetA, 'PRESENT', 'CLEAR', 'QUALIFIED'],
    [frames[1]!.frameId, targetB, 'UNSURE', 'CLEAR', 'NOT_QUALIFIED'],
    [frames[2]!.frameId, targetA, 'ABSENT', 'CLEAR', 'NOT_QUALIFIED'],
    [frames[2]!.frameId, targetB, 'PRESENT', 'CLEAR', 'QUALIFIED'],
    [frames[3]!.frameId, targetA, 'ABSENT', 'CLEAR', 'NOT_QUALIFIED'],
    [frames[3]!.frameId, targetB, 'ABSENT', 'CLEAR', 'NOT_QUALIFIED'],
  ];
  for (const [frameId, targetId, verdict, visibility, outcome] of labels) {
    db.raw
      .prepare(
        `INSERT INTO labels (frame_id, target_id, verdict, visibility, confidence, reason, outcome, call_id, created_at)
         VALUES (?, ?, ?, ?, 0.9, '测试', ?, ?, ?)`,
      )
      .run(frameId, targetId, verdict, visibility, outcome, `call-${frameId}`, at);
  }
  return { taskId, targetA, targetB, frames };
}

/** Minimal central-directory zip reader for tests; returns decoded entry bytes by archive path. */
export function readZipEntries(file: string): Map<string, Buffer> {
  const buffer = readFileSync(file);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('zip: missing end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function tableCount(db: LocalFramesDatabase, table: 'frames' | 'calls' | 'labels'): number {
  const row = db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
  return row?.count ?? 0;
}
