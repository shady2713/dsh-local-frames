import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  exportTask,
  recentExportFrom,
  rememberRecentExport,
  safeObjectDirectoryName,
  splitForFamily,
} from '../src/export.js';
import type { Pipeline } from '../src/pipeline.js';
import { SettingsStore } from '../src/settings.js';
import { createTools } from '../src/tool.js';
import type { StatusSnapshot, ToolResult } from '../src/types.js';
import { EnvironmentChecker } from '../src/versions.js';
import { fakeExec, healthySubprocess, makeTempDir } from './helpers.js';
import { readZipEntries, seedExportTask, tableCount } from './export-helpers.js';

function frameName(seeded: ReturnType<typeof seedExportTask>, index: number): string {
  return `clip-${seeded.frames[index]!.frameId}.jpg`;
}

function readLabels(directory: string): { header: string; rows: string[] } {
  const lines = readFileSync(join(directory, 'labels.csv'), 'utf8').trim().split('\n');
  return { header: lines[0] ?? '', rows: lines.slice(1) };
}

function makeTools(db: ReturnType<typeof openDatabase>, settings: SettingsStore, dataDir: string) {
  const environment = new EnvironmentChecker({
    subprocess: healthySubprocess(),
    dataDir,
    nodeVersion: '24.22.1',
    dshVersion: '0.2.1-rc.5',
    freeGb: () => 100,
  });
  return createTools({
    db,
    settings,
    dataDir,
    pipeline: { kick: () => undefined } as unknown as Pipeline,
    environment,
    log: () => undefined,
    buildStatus: async () => ({}) as unknown as StatusSnapshot,
  });
}

describe('object-filtered export', () => {
  it('keeps the previous full-export layout and values when no object is selected', () => {
    const dataDir = makeTempDir('lf-export-full-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const exported = exportTask(db, dataDir, seeded.taskId);
      expect(exported.zip).toBe(false);
      expect(exported.byObject).toBe(false);
      expect(exported.images).toBe(3);
      expect(exported.train + exported.val).toBe(3);
      expect(exported.directory.startsWith(join(dataDir, 'exports'))).toBe(true);
      expect(readdirSync(exported.directory).sort()).toEqual([
        'README.txt',
        'images',
        'labels.csv',
        'sources.csv',
        'stats.json',
      ]);
      const images = readdirSync(join(exported.directory, 'images')).sort();
      expect(images).toEqual([frameName(seeded, 0), frameName(seeded, 1), frameName(seeded, 2)].sort());

      const labels = readLabels(exported.directory);
      expect(labels.header).toBe('file_name,split,family_id,object-a,object-b');
      expect(labels.rows).toHaveLength(3);
      expect(labels.rows[0]?.split(',')).toEqual([
        frameName(seeded, 0),
        splitForFamily('family-a'),
        'family-a',
        '1',
        '1',
      ]);
      expect(labels.rows[1]?.split(',')).toEqual([frameName(seeded, 1), splitForFamily('family-a'), 'family-a', '1', '']);
      expect(labels.rows[2]?.split(',')).toEqual([frameName(seeded, 2), splitForFamily('family-a'), 'family-a', '0', '1']);

      const sources = readFileSync(join(exported.directory, 'sources.csv'), 'utf8').trim().split('\n');
      expect(sources[0]).toBe(
        'file_name,local_path,file_sha256,t_ms,family_id,url,author,license_raw,region,region_evidence',
      );
      expect(sources[1]).toContain('http://example.test/clip');
      expect(sources[1]).toContain('family-a');

      const readme = readFileSync(join(exported.directory, 'README.txt'), 'utf8');
      expect(readme).toContain('素材为用户预先下载的本地文件，用户确认可用');
      expect(readme).toContain('license_raw 照实记录');
      expect(readme).toContain('region 为 UNKNOWN 表示没有元数据证据');
      expect(readme).toContain('汉明距离≤16');
      expect(readme).toContain('统计报表：stats.json');

      const stats = JSON.parse(readFileSync(join(exported.directory, 'stats.json'), 'utf8')) as {
        mode: string;
        images: number;
        train: number;
        val: number;
        extracted_frames: number;
        judged_frames: number;
        model_calls: number;
        selected_targets: Array<{ name: string; qualified_frames: number }>;
      };
      expect(stats.mode).toBe('full');
      expect(stats.images).toBe(3);
      expect(stats.train + stats.val).toBe(3);
      expect(stats.extracted_frames).toBe(4);
      expect(stats.judged_frames).toBe(4);
      expect(stats.model_calls).toBe(4);
      expect(stats.selected_targets).toEqual([
        { target_id: seeded.targetA, name: 'object-a', directory: null, qualified_frames: 2 },
        { target_id: seeded.targetB, name: 'object-b', directory: null, qualified_frames: 2 },
      ]);
      expect(exported.directory).toContain('2026-');
    } finally {
      db.close();
    }
  });

  it('exports only qualified frames of one selected object, with only that CSV column', () => {
    const dataDir = makeTempDir('lf-export-filter-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const onlyA = exportTask(db, dataDir, seeded.taskId, new Date(), null, { targetIds: [seeded.targetA] });
      expect(onlyA.images).toBe(2);
      expect(onlyA.targetIds).toEqual([seeded.targetA]);
      expect(onlyA.targetNames).toEqual(['object-a']);
      expect(onlyA.stats.mode).toBe('selected');
      expect(readdirSync(join(onlyA.directory, 'images')).sort()).toEqual(
        [frameName(seeded, 0), frameName(seeded, 1)].sort(),
      );
      const labels = readLabels(onlyA.directory);
      expect(labels.header).toBe('file_name,split,family_id,object-a');
      expect(labels.rows).toHaveLength(2);
      for (const row of labels.rows) expect(row.split(',')[3]).toBe('1');

      const onlyB = exportTask(db, dataDir, seeded.taskId, new Date(), null, { targetIds: [seeded.targetB] });
      expect(onlyB.images).toBe(2);
      expect(readdirSync(join(onlyB.directory, 'images')).sort()).toEqual(
        [frameName(seeded, 0), frameName(seeded, 2)].sort(),
      );
      expect(readLabels(onlyB.directory).header).toBe('file_name,split,family_id,object-b');
      expect(onlyB.directory).not.toBe(onlyA.directory);
    } finally {
      db.close();
    }
  });

  it('reuses existing frames and labels for repeated exports and never overwrites an earlier run', () => {
    const dataDir = makeTempDir('lf-export-repeat-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const framesBefore = tableCount(db, 'frames');
      const callsBefore = tableCount(db, 'calls');
      const labelsBefore = tableCount(db, 'labels');
      const at = new Date('2026-03-04T05:06:07.000Z');
      const first = exportTask(db, dataDir, seeded.taskId, at, null, { targetIds: [seeded.targetA] });
      const firstLabels = readFileSync(join(first.directory, 'labels.csv'), 'utf8');
      const firstImages = readdirSync(join(first.directory, 'images')).sort();
      const second = exportTask(db, dataDir, seeded.taskId, at, null, { targetIds: [seeded.targetB] });

      expect(second.directory).not.toBe(first.directory);
      expect(second.directory.endsWith('-2')).toBe(true);
      expect(existsSync(join(first.directory, 'labels.csv'))).toBe(true);
      expect(readFileSync(join(first.directory, 'labels.csv'), 'utf8')).toBe(firstLabels);
      expect(readdirSync(join(first.directory, 'images')).sort()).toEqual(firstImages);
      expect(second.targetNames).toEqual(['object-b']);
      expect(second.images).toBe(2);

      // Re-export is pure reuse: no frame rows, labels or model calls are added.
      expect(tableCount(db, 'frames')).toBe(framesBefore);
      expect(tableCount(db, 'calls')).toBe(callsBefore);
      expect(tableCount(db, 'labels')).toBe(labelsBefore);
    } finally {
      db.close();
    }
  });
});

describe('zip export, object directories and stats', () => {
  it('writes images/<object>/ directories, one copy per matched object, plus stats.json in the zip', () => {
    const dataDir = makeTempDir('lf-export-zip-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const at = new Date('2026-04-05T06:07:08.000Z');
      const exported = exportTask(db, dataDir, seeded.taskId, at, null, {
        targetIds: [seeded.targetA, seeded.targetB],
        zip: true,
        byObject: true,
      });
      expect(exported.zip).toBe(true);
      expect(exported.directory.endsWith('.zip')).toBe(true);
      expect(existsSync(exported.directory)).toBe(true);
      expect(exported.imageCopies).toBe(4);

      const entries = readZipEntries(exported.directory);
      expect([...entries.keys()].sort()).toEqual(
        [
          'README.txt',
          'labels.csv',
          'sources.csv',
          'stats.json',
          `images/object-a/${frameName(seeded, 0)}`,
          `images/object-a/${frameName(seeded, 1)}`,
          `images/object-b/${frameName(seeded, 0)}`,
          `images/object-b/${frameName(seeded, 2)}`,
        ].sort(),
      );
      expect(entries.get(`images/object-a/${frameName(seeded, 0)}`)?.toString()).toBe(seeded.frames[0]?.content);
      expect(entries.get(`images/object-b/${frameName(seeded, 0)}`)?.toString()).toBe(seeded.frames[0]?.content);

      const labels = (entries.get('labels.csv') ?? Buffer.alloc(0)).toString().trim().split('\n');
      expect(labels[0]).toBe('file_name,split,family_id,object-a,object-b');
      expect(labels[1]?.split(',')[0]).toBe(`object-a/${frameName(seeded, 0)}`);
      expect(labels[3]?.split(',')[0]).toBe(`object-b/${frameName(seeded, 2)}`);

      const stats = JSON.parse((entries.get('stats.json') ?? Buffer.alloc(0)).toString()) as {
        zip: boolean;
        by_object: boolean;
        images: number;
        image_copies: number;
        train: number;
        val: number;
        selected_targets: Array<{ name: string; directory: string; qualified_frames: number }>;
      };
      expect(stats.zip).toBe(true);
      expect(stats.by_object).toBe(true);
      expect(stats.images).toBe(3);
      expect(stats.image_copies).toBe(4);
      expect(stats.train + stats.val).toBe(3);
      expect(stats.selected_targets).toEqual([
        { target_id: seeded.targetA, name: 'object-a', directory: 'object-a', qualified_frames: 2 },
        { target_id: seeded.targetB, name: 'object-b', directory: 'object-b', qualified_frames: 2 },
      ]);

      const again = exportTask(db, dataDir, seeded.taskId, at, null, { zip: true });
      expect(again.directory).not.toBe(exported.directory);
      expect(again.directory.endsWith('-2.zip')).toBe(true);
      expect(existsSync(exported.directory)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('sanitizes object directory names and keeps them unique', () => {
    const used = new Set<string>();
    expect(safeObjectDirectoryName('汽车 A/B', used)).toBe('汽车-A-B');
    expect(safeObjectDirectoryName('汽车-A/B', used)).toBe('汽车-A-B-2');
    expect(safeObjectDirectoryName('  ', used)).toBe('object');
  });
});

describe('lf_export tool parameters and recent exports', () => {
  it('exports selected objects, persists recent records and rejects objects outside the task', async () => {
    const dataDir = makeTempDir('lf-export-tool-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const settings = new SettingsStore(db);
      const exportRoot = makeTempDir('lf-export-tool-root-');
      settings.update({ exportDir: exportRoot });
      const tool = makeTools(db, settings, dataDir).find((entry) => entry.name === 'lf_export');
      if (tool === undefined) throw new Error('lf_export missing');

      const first = (await tool.execute(
        { taskId: seeded.taskId, targetIds: [seeded.targetA], byObject: true },
        fakeExec(),
      )) as ToolResult;
      expect(first.status).toBe('OK');
      expect(first.data.images).toBe(2);
      expect(first.data.targetNames).toEqual(['object-a']);
      expect(String(first.data.directory).startsWith(exportRoot)).toBe(true);
      const afterFirst = new SettingsStore(db).load().recentExports;
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]).toMatchObject({
        task_id: seeded.taskId,
        target_ids: [seeded.targetA],
        target_names: ['object-a'],
        images: 2,
        directory: first.data.directory,
        zip: false,
      });

      const second = (await tool.execute(
        { taskId: seeded.taskId, targetIds: [seeded.targetB], zip: true },
        fakeExec(),
      )) as ToolResult;
      expect(second.status).toBe('OK');
      expect(second.data.zip).toBe(true);
      const afterSecond = new SettingsStore(db).load().recentExports;
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond[0]?.directory).toBe(second.data.directory);
      expect(afterSecond[0]?.zip).toBe(true);
      expect(afterSecond[1]?.directory).toBe(first.data.directory);

      const missing = (await tool.execute(
        { taskId: seeded.taskId, targetIds: ['not-in-task'] },
        fakeExec(),
      )) as ToolResult;
      expect(missing.status).toBe('ERROR');
      expect(missing.message).toContain('对象不在该任务中');
      expect(new SettingsStore(db).load().recentExports).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('records exports newest first through the persisted helper', () => {
    const dataDir = makeTempDir('lf-export-recent-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const settings = new SettingsStore(db);
      const first = exportTask(db, dataDir, seeded.taskId);
      rememberRecentExport(settings, recentExportFrom(first, seeded.taskId));
      const second = exportTask(db, dataDir, seeded.taskId);
      const recent = rememberRecentExport(settings, recentExportFrom(second, seeded.taskId));
      expect(recent).toHaveLength(2);
      expect(recent[0]?.directory).toBe(second.directory);
      expect(recent[1]?.directory).toBe(first.directory);
      expect(new SettingsStore(db).load().recentExports).toEqual(recent);
    } finally {
      db.close();
    }
  });
});
