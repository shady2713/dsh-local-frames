import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { removeOwnedFrame } from './cleanup.js';
import type { LocalFramesDatabase } from './db.js';
import { sourceFromProbe } from './ingest.js';
import { nowIso } from './ids.js';
import { csvCell } from './prompt.js';
import { readSpec } from './progress.js';
import { MAX_RECENT_EXPORTS, type SettingsStore } from './settings.js';
import type { Outcome, RecentExport, Verdict } from './types.js';
import { writeZip, type ZipEntryInput } from './zip.js';

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

/** Sanitize an object name for use as one directory component; collisions get a suffix. */
export function safeObjectDirectoryName(name: string, used: Set<string>): string {
  const cleaned = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const base = cleaned.length > 0 ? cleaned.slice(0, 60) : 'object';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
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

interface TaskTarget {
  target_id: string;
  name: string;
}

interface ExportTarget extends TaskTarget {
  /** Output directory component when exports are split by object, else null. */
  directory: string | null;
}

function loadTargets(db: LocalFramesDatabase, targetIds: readonly string[]): TaskTarget[] {
  if (targetIds.length === 0) return [];
  const rows = db.raw
    .prepare(`SELECT target_id, name FROM targets WHERE target_id IN (${targetIds.map(() => '?').join(',')})`)
    .all(...targetIds) as unknown as TaskTarget[];
  const byId = new Map(rows.map((row) => [row.target_id, row]));
  const ordered: TaskTarget[] = [];
  for (const id of targetIds) {
    const row = byId.get(id);
    if (row !== undefined) ordered.push(row);
  }
  return ordered;
}

function selectExportTargets(
  taskTargets: readonly TaskTarget[],
  requested: readonly string[] | null,
): { targets: ExportTarget[]; filtered: boolean } {
  if (requested === null || requested.length === 0) {
    return { targets: taskTargets.map((target) => ({ ...target, directory: null })), filtered: false };
  }
  const byId = new Map(taskTargets.map((target) => [target.target_id, target]));
  const targets: ExportTarget[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const target = byId.get(id);
    if (target === undefined) throw new ExportSelectionError(`对象不在该任务中：${id}`);
    targets.push({ ...target, directory: null });
  }
  return { targets, filtered: true };
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

/** Bad object selection: callers map this to a user-visible 4xx instead of an internal error. */
export class ExportSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportSelectionError';
  }
}

export interface ExportOptions {
  /** Object ids to include; null or empty means every object selected by the task. */
  targetIds: readonly string[] | null;
  /** Write `<导出目录>/<时间>.zip` instead of a directory. */
  zip: boolean;
  /** Place images under `images/<object directory>/`. */
  byObject: boolean;
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = { targetIds: null, zip: false, byObject: false };

export interface ExportTargetStats {
  target_id: string;
  name: string;
  directory: string | null;
  qualified_frames: number;
}

/** Machine-readable report written as `stats.json` next to the CSV files. */
export interface ExportStats {
  task_id: string;
  task_status: string;
  exported_at: string;
  mode: 'full' | 'selected';
  zip: boolean;
  by_object: boolean;
  selected_targets: ExportTargetStats[];
  images: number;
  image_copies: number;
  train: number;
  val: number;
  extracted_frames: number;
  judged_frames: number;
  duplicates_skipped: number;
  model_calls: number;
  model_calls_ok: number;
  items: number;
}

export interface ExportResult {
  /** Export artifact: the export directory, or the zip file path when `zip` is true. */
  directory: string;
  images: number;
  train: number;
  val: number;
  duplicatesSkipped: number;
  zip: boolean;
  byObject: boolean;
  targetIds: string[];
  targetNames: string[];
  imageCopies: number;
  stats: ExportStats;
}

function stamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/gu, '')}`;
}

function createExportDirectory(root: string, base: string): string {
  let candidate = join(root, base);
  let suffix = 2;
  for (;;) {
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      candidate = join(root, `${base}-${suffix}`);
      suffix += 1;
    }
  }
}

function uniqueZipPath(root: string, base: string): string {
  let candidate = join(root, `${base}.zip`);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = join(root, `${base}-${suffix}.zip`);
    suffix += 1;
  }
  return candidate;
}

function taskScalar(db: LocalFramesDatabase, sql: string, ...params: Array<string | number>): number {
  const row = db.raw.prepare(sql).get(...params) as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

/**
 * Write a new export artifact under the configured export root
 * (default `dataDir/exports`): a timestamped directory, or a timestamped zip.
 * Only existing frames and labels are reused; nothing is extracted or judged
 * here, and previous exports are never overwritten.
 */
export function exportTask(
  db: LocalFramesDatabase,
  dataDir: string,
  taskId: string,
  now: Date = new Date(),
  exportDir: string | null = null,
  options: Partial<ExportOptions> = {},
): ExportResult {
  const chosen: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...options };
  if (chosen.targetIds !== null && chosen.targetIds.length > 100) {
    throw new ExportSelectionError('一次最多选择 100 个对象');
  }
  if (chosen.targetIds !== null) {
    for (const id of chosen.targetIds) {
      if (typeof id !== 'string' || id.trim().length === 0) throw new ExportSelectionError('对象 id 无效');
    }
  }
  const task = db.raw.prepare('SELECT spec_json, progress_json, status FROM tasks WHERE task_id = ?').get(taskId) as
    | { spec_json?: string; progress_json?: string; status?: string }
    | undefined;
  if (task === undefined) throw new Error('任务不存在');
  const spec = readSpec(task.spec_json);
  discardUnexportableFrames(db, dataDir, taskId);
  const taskTargets = loadTargets(db, spec.targetIds);
  const { targets, filtered } = selectExportTargets(taskTargets, chosen.targetIds);

  const usedDirectoryNames = new Set<string>();
  for (const target of targets) {
    target.directory = chosen.byObject ? safeObjectDirectoryName(target.name, usedDirectoryNames) : null;
  }

  const targetPlaceholders = targets.map(() => '?').join(',');
  const filterClause = filtered ? ` AND labels.target_id IN (${targetPlaceholders})` : '';
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
           SELECT 1 FROM labels WHERE labels.frame_id = frames.frame_id AND labels.outcome = 'QUALIFIED'${filterClause}
         )
       ORDER BY items.created_at ASC, items.rowid ASC, frames.t_ms ASC, frames.rowid ASC`,
    )
    .all(taskId, ...(filtered ? targets.map((target) => target.target_id) : [])) as unknown as ExportFrame[];

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
  const baseStamp = stamp(now);
  // The zip path is reserved here; writeZip creates it with `wx` and never overwrites.
  const artifact = chosen.zip ? uniqueZipPath(exportsRoot, baseStamp) : createExportDirectory(exportsRoot, baseStamp);
  let imagesDir: string | null = null;
  if (!chosen.zip) {
    imagesDir = join(artifact, 'images');
    mkdirSync(imagesDir, { recursive: true });
    if (chosen.byObject) {
      for (const target of targets) mkdirSync(join(imagesDir, target.directory ?? 'object'), { recursive: true });
    }
  }
  const zipImages: ZipEntryInput[] = [];

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
  let imageCopies = 0;
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
    const frameLabels = byFrame.get(frame.frame_id);
    const qualified = targets.filter((target) => frameLabels?.get(target.target_id)?.outcome === 'QUALIFIED');
    // Full exports keep the previous behaviour (every qualified frame); selections are already filtered in SQL.
    if (filtered && qualified.length === 0) continue;
    const primary = qualified[0];
    const labelName = primary?.directory === null || primary?.directory === undefined
      ? fileName
      : `${primary.directory}/${fileName}`;
    // Without byObject every frame is placed once at images/<file>, however many objects match.
    const placements: Array<ExportTarget | null> = chosen.byObject && qualified.length > 0 ? qualified : [null];
    if (chosen.zip) {
      for (const target of placements) {
        const prefix = target?.directory === null || target?.directory === undefined ? '' : `${target.directory}/`;
        zipImages.push({ name: `images/${prefix}${fileName}`, source: frame.path, compress: false });
      }
    } else {
      for (const target of placements) {
        const destination = target?.directory === null || target?.directory === undefined
          ? join(imagesDir ?? artifact, fileName)
          : join(imagesDir ?? artifact, target.directory, fileName);
        placeImage(frame.path, destination);
      }
    }
    imageCopies += placements.length;

    const cells = [labelName, split, family];
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
        labelName,
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

  const selectedTargetStats: ExportTargetStats[] = targets.map((target) => ({
    target_id: target.target_id,
    name: target.name,
    directory: target.directory,
    qualified_frames: perTarget.get(target.target_id)?.qualified ?? 0,
  }));
  const exportedTargetIds = targets.map((target) => target.target_id);
  const exportedTargetNames = targets.map((target) => target.name);
  const stats: ExportStats = {
    task_id: taskId,
    task_status: typeof task.status === 'string' ? task.status : 'UNKNOWN',
    exported_at: now.toISOString(),
    mode: filtered ? 'selected' : 'full',
    zip: chosen.zip,
    by_object: chosen.byObject,
    selected_targets: selectedTargetStats,
    images: frames.length,
    image_copies: imageCopies,
    train,
    val,
    extracted_frames: taskScalar(
      db,
      'SELECT COUNT(*) AS count FROM frames WHERE item_id IN (SELECT item_id FROM items WHERE task_id = ?)',
      taskId,
    ),
    judged_frames: taskScalar(
      db,
      "SELECT COUNT(*) AS count FROM frames WHERE state = 'JUDGED' AND item_id IN (SELECT item_id FROM items WHERE task_id = ?)",
      taskId,
    ),
    duplicates_skipped: duplicatesSkipped,
    model_calls: taskScalar(
      db,
      `SELECT COUNT(*) AS count FROM calls
       JOIN frames ON frames.frame_id = calls.frame_id
       JOIN items ON items.item_id = frames.item_id
       WHERE items.task_id = ?`,
      taskId,
    ),
    model_calls_ok: taskScalar(
      db,
      `SELECT COUNT(*) AS count FROM calls
       JOIN frames ON frames.frame_id = calls.frame_id
       JOIN items ON items.item_id = frames.item_id
       WHERE items.task_id = ? AND calls.ok = 1`,
      taskId,
    ),
    items: taskScalar(db, 'SELECT COUNT(*) AS count FROM items WHERE task_id = ?', taskId),
  };

  const labelsText = `${labelLines.join('\n')}\n`;
  const sourcesText = `${sourceLines.join('\n')}\n`;
  const readmeText = renderReadme({
    model: spec.model,
    interval: spec.frameIntervalSeconds,
    duplicatesSkipped,
    images: frames.length,
    imageCopies,
    train,
    val,
    targets: selectedTargetStats,
    filtered,
    taskTargetCount: taskTargets.length,
    byObject: chosen.byObject,
    zip: chosen.zip,
    perTarget,
    regionCounts,
    fileCounts,
  });
  const statsText = `${JSON.stringify(stats, null, 2)}\n`;

  if (chosen.zip) {
    writeZip(
      artifact,
      [
        ...zipImages,
        { name: 'labels.csv', source: Buffer.from(labelsText, 'utf8'), compress: true },
        { name: 'sources.csv', source: Buffer.from(sourcesText, 'utf8'), compress: true },
        { name: 'README.txt', source: Buffer.from(readmeText, 'utf8'), compress: true },
        { name: 'stats.json', source: Buffer.from(statsText, 'utf8'), compress: true },
      ],
      now,
    );
  } else {
    writeFileSync(join(artifact, 'labels.csv'), labelsText, 'utf8');
    writeFileSync(join(artifact, 'sources.csv'), sourcesText, 'utf8');
    writeFileSync(join(artifact, 'README.txt'), readmeText, 'utf8');
    writeFileSync(join(artifact, 'stats.json'), statsText, 'utf8');
  }

  return {
    directory: artifact,
    images: frames.length,
    train,
    val,
    duplicatesSkipped,
    zip: chosen.zip,
    byObject: chosen.byObject,
    targetIds: exportedTargetIds,
    targetNames: exportedTargetNames,
    imageCopies,
    stats,
  };
}

/** Build the settings record for one successful export. */
export function recentExportFrom(result: ExportResult, taskId: string): RecentExport {
  return {
    exported_at: result.stats.exported_at,
    task_id: taskId,
    target_ids: result.targetIds,
    target_names: result.targetNames,
    images: result.images,
    train: result.train,
    val: result.val,
    directory: result.directory,
    zip: result.zip,
  };
}

/** Prepend one export to the persisted history, newest first, capped. */
export function rememberRecentExport(settings: SettingsStore, record: RecentExport): RecentExport[] {
  const recent = [record, ...settings.load().recentExports.filter((entry) => entry.directory !== record.directory)].slice(
    0,
    MAX_RECENT_EXPORTS,
  );
  settings.update({ recentExports: recent });
  return recent;
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
  imageCopies: number;
  train: number;
  val: number;
  targets: ExportTargetStats[];
  filtered: boolean;
  taskTargetCount: number;
  byObject: boolean;
  zip: boolean;
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
    `图片副本：${input.imageCopies}`,
    `train：${input.train}`,
    `val：${input.val}`,
    `导出对象：${input.targets.map((target) => target.name).join('、') || '（无）'}${
      input.filtered ? `（从任务的 ${input.taskTargetCount} 个对象中筛选）` : '（任务全部对象）'
    }`,
    `导出格式：${input.zip ? 'zip' : '目录'}`,
    '统计报表：stats.json（统计各对象合格帧数、抽帧/去重/打标数以及 train/val 划分）',
  ];
  if (input.byObject) {
    lines.push(
      '图片按对象分目录：images/<对象目录>/。同一帧命中多个选中对象时，会在每个命中的对象目录各放一份（硬链接）；labels.csv 的 file_name 指向按本次对象顺序第一个命中的对象目录下的文件。',
    );
  }
  lines.push('', '每个对象的帧数：');
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
