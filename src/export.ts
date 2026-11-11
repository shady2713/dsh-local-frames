import { createHash } from 'node:crypto';
import { copyFileSync, linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { removeOwnedFrame } from './cleanup.js';
import type { LocalFramesDatabase } from './db.js';
import { sourceFromProbe } from './ingest.js';
import { nowIso } from './ids.js';
import { csvCell } from './prompt.js';
import { readSpec } from './progress.js';
import type { Outcome, Verdict } from './types.js';

export function splitForFamily(familyId: string): 'train' | 'val' {
  const hex = createHash('sha256').update(familyId).digest('hex');
  const prefix = hex.slice(0, 2);
  return Number.parseInt(prefix, 16) < 205 ? 'train' : 'val';
}

export function familyIdFor(family: string, fileSha256: string): string {
  const trimmed = family.trim();
  return trimmed.length > 0 ? trimmed : fileSha256;
}

export function exportFileName(title: string, frameId: string, used: Set<string>): string {
  const stem = basename(title).replace(/\.[^.]+$/u, '');
  const cleaned = stem.replace(/[^A-Za-z0-9_-]+/gu, '');
  const safeStem = cleaned.length > 0 ? cleaned : 'frame';
  const safeId = frameId.replace(/[^A-Za-z0-9_-]+/gu, '');
  let name = `${safeStem}-${safeId}.jpg`;
  let suffix = 2;
  while (used.has(name)) {
    name = `${safeStem}-${safeId}-${suffix}.jpg`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function csvField(value: string): string {
  if (/[",\r\n]/u.test(value)) return `"${value.replace(/"/gu, '""')}"`;
  return value;
}

function csvLine(cells: readonly string[]): string {
  return cells.map(csvField).join(',');
}

function placeImage(source: string, dest: string): 'link' | 'copy' {
  try {
    linkSync(source, dest);
    return 'link';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EEXIST') {
      if (code !== 'EEXIST') copyFileSync(source, dest);
      return 'copy';
    }
    throw error;
  }
}

interface ExportFrame {
  frame_id: string;
  t_ms: number;
  path: string;
  local_path: string;
  file_sha256: string;
  title: string;
  author: string;
  license_raw: string;
  region: string;
  region_evidence: string;
  probe_json: string;
}

interface LabelCell {
  verdict: Verdict;
  outcome: Outcome;
}

function loadTargets(db: LocalFramesDatabase, targetIds: readonly string[]): Array<{ target_id: string; name: string }> {
  if (targetIds.length === 0) return [];
  const rows = db.raw
    .prepare(`SELECT target_id, name FROM targets WHERE target_id IN (${targetIds.map(() => '?').join(',')})`)
    .all(...targetIds) as Array<{ target_id: string; name: string }>;
  const byId = new Map(rows.map((row) => [row.target_id, row]));
  const ordered: Array<{ target_id: string; name: string }> = [];
  for (const id of targetIds) {
    const row = byId.get(id);
    if (row !== undefined) ordered.push(row);
  }
  return ordered;
}

/** Delete judged frames that have no QUALIFIED object. Duplicate frames are never exported. */
export function discardUnexportableFrames(db: LocalFramesDatabase, dataDir: string, taskId: string): number {
  const rows = db.raw
    .prepare(
      `SELECT frames.frame_id, frames.path FROM frames
       JOIN items ON items.item_id = frames.item_id
       WHERE items.task_id = ?
         AND frames.state = 'JUDGED'
         AND frames.frame_id NOT IN (
           SELECT frame_id FROM labels WHERE outcome = 'QUALIFIED'
         )`,
    )
    .all(taskId) as Array<{ frame_id: string; path: string | null }>;
  let removed = 0;
  for (const row of rows) {
    if (typeof row.path === 'string' && row.path.length > 0) {
      removeOwnedFrame(dataDir, row.path);
      removed += 1;
    }
    db.raw.prepare('UPDATE frames SET path = NULL, updated_at = ? WHERE frame_id = ?').run(nowIso(), row.frame_id);
  }
  return removed;
}

export interface ExportResult {
  directory: string;
  images: number;
  train: number;
  val: number;
  duplicatesSkipped: number;
}

function stamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/gu, '')}`;
}

/**
 * Write `<exportDir>/<time>/` (default `dataDir/exports/<time>/`) with hardlinked
 * images, labels.csv, sources.csv and README.txt. User files are only read.
 * The directory is not modified again after this function returns.
 */
export function exportTask(
  db: LocalFramesDatabase,
  dataDir: string,
  taskId: string,
  now: Date = new Date(),
  exportDir: string | null = null,
): ExportResult {
  const task = db.raw.prepare('SELECT spec_json, progress_json, status FROM tasks WHERE task_id = ?').get(taskId) as
    | { spec_json?: string; progress_json?: string; status?: string }
    | undefined;
  if (task === undefined) throw new Error('任务不存在');
  const spec = readSpec(task.spec_json);
  discardUnexportableFrames(db, dataDir, taskId);
  const targets = loadTargets(db, spec.targetIds);
  const frames = db.raw
    .prepare(
      `SELECT frames.frame_id, frames.t_ms, frames.path,
              items.local_path, items.file_sha256, items.title, items.author, items.license_raw,
              items.region, items.region_evidence, items.probe_json
       FROM frames
       JOIN items ON items.item_id = frames.item_id
       WHERE items.task_id = ?
         AND frames.state = 'JUDGED'
         AND frames.path IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM labels WHERE labels.frame_id = frames.frame_id AND labels.outcome = 'QUALIFIED'
         )
       ORDER BY items.created_at ASC, items.rowid ASC, frames.t_ms ASC, frames.rowid ASC`,
    )
    .all(taskId) as unknown as ExportFrame[];

  const duplicateRow = db.raw
    .prepare(
      `SELECT COUNT(*) AS count FROM frames
       JOIN items ON items.item_id = frames.item_id
       WHERE items.task_id = ? AND frames.state = 'DUPLICATE'`,
    )
    .get(taskId) as { count?: number } | undefined;
  const duplicatesSkipped = typeof duplicateRow?.count === 'number' ? duplicateRow.count : 0;

  if (exportDir !== null && !isAbsolute(exportDir)) throw new Error('导出目录必须是绝对路径');
  const exportsRoot = exportDir === null ? resolve(dataDir, 'exports') : resolve(normalize(exportDir));
  mkdirSync(exportsRoot, { recursive: true });
  let folder = stamp(now);
  let directory = join(exportsRoot, folder);
  let suffix = 2;
  while (existsDir(directory)) {
    folder = `${stamp(now)}-${suffix}`;
    directory = join(exportsRoot, folder);
    suffix += 1;
  }
  const imagesDir = join(directory, 'images');
  mkdirSync(imagesDir, { recursive: true });

  const labelRows = db.raw
    .prepare(
      `SELECT labels.frame_id, labels.target_id, labels.verdict, labels.outcome
       FROM labels
       JOIN frames ON frames.frame_id = labels.frame_id
       JOIN items ON items.item_id = frames.item_id
       WHERE items.task_id = ?`,
    )
    .all(taskId) as Array<{ frame_id: string; target_id: string; verdict: string; outcome: string }>;
  const byFrame = new Map<string, Map<string, LabelCell>>();
  for (const row of labelRows) {
    if (!isVerdict(row.verdict) || !isOutcome(row.outcome)) continue;
    let frameLabels = byFrame.get(row.frame_id);
    if (frameLabels === undefined) {
      frameLabels = new Map();
      byFrame.set(row.frame_id, frameLabels);
    }
    frameLabels.set(row.target_id, { verdict: row.verdict, outcome: row.outcome });
  }

  const usedNames = new Set<string>();
  const labelLines = [csvLine(['file_name', 'split', 'family_id', ...targets.map((target) => target.name)])];
  const sourceLines = [
    csvLine([
      'file_name',
      'local_path',
      'file_sha256',
      't_ms',
      'family_id',
      'url',
      'author',
      'license_raw',
      'region',
      'region_evidence',
    ]),
  ];
  let train = 0;
  let val = 0;
  const regionCounts = new Map<string, number>();
  const perTarget = new Map<string, { qualified: number; unsure: number; absent: number }>();
  for (const target of targets) perTarget.set(target.target_id, { qualified: 0, unsure: 0, absent: 0 });
  const fileCounts = new Map<string, number>();

  for (const frame of frames) {
    const source = sourceFromProbe(frame.probe_json);
    const family = familyIdFor(source.family, frame.file_sha256);
    const split = splitForFamily(family);
    if (split === 'train') train += 1;
    else val += 1;
    const fileName = exportFileName(frame.title, frame.frame_id, usedNames);
    placeImage(frame.path, join(imagesDir, fileName));
    const cells = [fileName, split, family];
    const frameLabels = byFrame.get(frame.frame_id);
    for (const target of targets) {
      const label = frameLabels?.get(target.target_id) ?? null;
      cells.push(csvCell(label));
      const tally = perTarget.get(target.target_id);
      if (tally !== undefined && label !== null) {
        if (label.outcome === 'QUALIFIED') tally.qualified += 1;
        else if (label.outcome === 'UNSURE') tally.unsure += 1;
        else if (label.verdict === 'ABSENT') tally.absent += 1;
      }
    }
    labelLines.push(csvLine(cells));
    sourceLines.push(
      csvLine([
        fileName,
        frame.local_path,
        frame.file_sha256,
        String(frame.t_ms),
        family,
        source.url,
        frame.author,
        frame.license_raw,
        frame.region.length > 0 ? frame.region : 'UNKNOWN',
        frame.region_evidence,
      ]),
    );
    regionCounts.set(frame.region || 'UNKNOWN', (regionCounts.get(frame.region || 'UNKNOWN') ?? 0) + 1);
    fileCounts.set(frame.local_path, (fileCounts.get(frame.local_path) ?? 0) + 1);
  }

  writeFileSync(join(directory, 'labels.csv'), `${labelLines.join('\n')}\n`, 'utf8');
  writeFileSync(join(directory, 'sources.csv'), `${sourceLines.join('\n')}\n`, 'utf8');
  writeFileSync(
    join(directory, 'README.txt'),
    renderReadme({
      model: spec.model,
      interval: spec.frameIntervalSeconds,
      duplicatesSkipped,
      images: frames.length,
      train,
      val,
      targets,
      perTarget,
      regionCounts,
      fileCounts,
    }),
    'utf8',
  );

  return { directory, images: frames.length, train, val, duplicatesSkipped };
}

function existsDir(path: string): boolean {
  try {
    mkdirSync(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return true;
    throw error;
  }
}

function isVerdict(value: string): value is Verdict {
  return value === 'PRESENT' || value === 'ABSENT' || value === 'UNSURE';
}

function isOutcome(value: string): value is Outcome {
  return value === 'QUALIFIED' || value === 'UNSURE' || value === 'NOT_QUALIFIED';
}

function renderReadme(input: {
  model: { provider: string; model: string } | null;
  interval: number;
  duplicatesSkipped: number;
  images: number;
  train: number;
  val: number;
  targets: Array<{ target_id: string; name: string }>;
  perTarget: Map<string, { qualified: number; unsure: number; absent: number }>;
  regionCounts: Map<string, number>;
  fileCounts: Map<string, number>;
}): string {
  const lines = [
    '本地视频帧导出',
    '素材为用户预先下载的本地文件，用户确认可用',
    'license_raw 照实记录',
    'region 为 UNKNOWN 表示没有元数据证据',
    '',
    `所用模型：${input.model === null ? '未记录' : `${input.model.provider}/${input.model.model}`}`,
    `抽帧间隔：${input.interval} 秒`,
    '帧去重：dHash 64 位，汉明距离≤16',
    `重复跳过数：${input.duplicatesSkipped}`,
    `导出图片：${input.images}`,
    `train：${input.train}`,
    `val：${input.val}`,
    '',
    '每个对象的帧数：',
  ];
  if (input.targets.length === 0) lines.push('（无）');
  for (const target of input.targets) {
    const tally = input.perTarget.get(target.target_id) ?? { qualified: 0, unsure: 0, absent: 0 };
    lines.push(
      `- ${target.name}：QUALIFIED ${tally.qualified}，UNSURE ${tally.unsure}，ABSENT ${tally.absent}`,
    );
  }
  lines.push('', '文件分布：');
  if (input.fileCounts.size === 0) lines.push('（无）');
  for (const [file, count] of input.fileCounts) lines.push(`- ${file}：${count}`);
  lines.push('', '地区占比：');
  const regionTotal = [...input.regionCounts.values()].reduce((sum, count) => sum + count, 0);
  if (regionTotal === 0) lines.push('- 无');
  for (const [region, count] of input.regionCounts) {
    const percent = regionTotal === 0 ? 0 : Math.round((count / regionTotal) * 1000) / 10;
    lines.push(`- ${region}：${count}（${percent}%）`);
  }
  const gaps = input.targets.filter((target) => (input.perTarget.get(target.target_id)?.qualified ?? 0) === 0);
  lines.push('', '缺口：');
  if (gaps.length === 0) lines.push('- 导出中每个对象至少有一帧 QUALIFIED，或本次没有对象。');
  for (const target of gaps) lines.push(`- ${target.name} 没有 QUALIFIED 帧`);
  lines.push('');
  return lines.join('\n');
}
