import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { removeOwnedFrame } from './cleanup.js';
import { CsvError, EMPTY_SOURCE, lookupSource, parseSourceCsv, type CsvTable, type SourceMeta } from './csv.js';
import type { LocalFramesDatabase } from './db.js';
import { nowIso, newId } from './ids.js';
import { InputError, validateVideoPath, VIDEO_EXTENSIONS } from './input.js';

export interface IngestRejection {
  path: string;
  code: string;
  message: string;
}

export interface IngestedItem {
  itemId: string;
  localPath: string;
  fileSha256: string;
  /** True when the same bytes were already stored on a different task. */
  usedElsewhere: boolean;
  /** True when an existing row was reset because the caller forced a rerun. */
  forced?: boolean;
}

export interface IngestReport {
  /** Newly inserted rows the state machine will process. */
  added: IngestedItem[];
  /** New rows skipped because an earlier task already framed and labelled these bytes. */
  skipped: IngestedItem[];
  /** Existing rows reset to NEW by an explicit force rerun. */
  rerun: IngestedItem[];
  existing: IngestedItem[];
  rejected: IngestRejection[];
  csvErrors: Array<{ path: string; message: string }>;
}

export interface IngestOptions {
  /** Explicitly rerun files that exist in this task or were processed by an earlier task. */
  force?: boolean;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Same bytes already stored under another task (regardless of processing state). */
function usedElsewhere(db: LocalFramesDatabase, digest: string, taskId: string): boolean {
  const row = db.raw
    .prepare('SELECT 1 AS found FROM items WHERE file_sha256 = ? AND task_id != ? LIMIT 1')
    .get(digest, taskId) as { found?: number } | undefined;
  return row !== undefined;
}

/**
 * Issue #7: a prior item reaches DONE only after the state machine framed it
 * and no usable pending frame remains. Such bytes are skipped by default in
 * new tasks; ERROR or still-running items are imported normally.
 */
function previouslyProcessed(db: LocalFramesDatabase, digest: string, taskId: string): boolean {
  const row = db.raw
    .prepare("SELECT 1 AS found FROM items WHERE file_sha256 = ? AND task_id != ? AND state = 'DONE' LIMIT 1")
    .get(digest, taskId) as { found?: number } | undefined;
  return row !== undefined;
}

async function loadCsv(file: string, errors: IngestReport['csvErrors']): Promise<CsvTable | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseSourceCsv(text);
  } catch (error) {
    const message = error instanceof CsvError || error instanceof Error ? error.message : String(error);
    errors.push({ path: file, message });
    return null;
  }
}

async function csvForDirectory(
  directory: string,
  dataDir: string,
  cache: Map<string, CsvTable | null>,
  errors: IngestReport['csvErrors'],
): Promise<CsvTable | null> {
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;
  const merged: CsvTable = { byKey: new Map() };
  const candidates = [join(directory, 'metadata.csv'), join(dataDir, 'metadata.csv')];
  const extras: string[] = [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      if (!entry.name.toLowerCase().endsWith('.csv')) continue;
      extras.push(entry.name);
    }
  } catch {
    // 目录不可读时仍尝试 metadata.csv
  }
  extras.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const name of extras) {
    const path = join(directory, name);
    if (!candidates.includes(path)) candidates.push(path);
  }
  for (const candidate of candidates) {
    const table = await loadCsv(candidate, errors);
    if (table === null) continue;
    for (const [key, value] of table.byKey) {
      if (!merged.byKey.has(key)) merged.byKey.set(key, value);
    }
  }
  const result = merged.byKey.size === 0 ? null : merged;
  cache.set(directory, result);
  return result;
}

function sourceForFile(table: CsvTable | null, file: string, stemTable: CsvTable | null): SourceMeta {
  return lookupSource(stemTable, file).url.length > 0 || stemTable?.byKey.has(basename(file)) === true
    ? lookupSource(stemTable, file)
    : lookupSource(table, file);
}

async function metadataForFile(
  file: string,
  dataDir: string,
  cache: Map<string, CsvTable | null>,
  errors: IngestReport['csvErrors'],
): Promise<SourceMeta> {
  const directory = dirname(file);
  const table = await csvForDirectory(directory, dataDir, cache, errors);
  const stemCsv = await loadCsv(`${file.slice(0, file.lastIndexOf('.'))}.csv`, errors);
  const meta = stemCsv === null ? lookupSource(table, file) : sourceForFile(table, file, stemCsv);
  return meta.url.length === 0 && meta.author.length === 0 ? { ...EMPTY_SOURCE, ...meta } : meta;
}

function probeJsonFor(meta: SourceMeta): string {
  return JSON.stringify({ source: { url: meta.url, family: meta.family } });
}

interface FrameFile {
  frame_id: string;
  path: string | null;
}

/**
 * Explicit force rerun of one existing row: drop its frames/labels/calls and
 * reset the item to NEW. Only plugin-owned frame files are removed; the user's
 * original video is never touched.
 */
function resetItemForRerun(db: LocalFramesDatabase, dataDir: string, itemId: string): FrameFile[] {
  const frames = db.raw.prepare('SELECT frame_id, path FROM frames WHERE item_id = ?').all(itemId) as unknown as FrameFile[];
  db.raw.exec('BEGIN IMMEDIATE');
  try {
    for (const frame of frames) {
      db.raw.prepare('DELETE FROM calls WHERE frame_id = ?').run(frame.frame_id);
      db.raw.prepare('DELETE FROM labels WHERE frame_id = ?').run(frame.frame_id);
    }
    db.raw.prepare('DELETE FROM frames WHERE item_id = ?').run(itemId);
    db.raw.exec('COMMIT');
  } catch (error) {
    try {
      db.raw.exec('ROLLBACK');
    } catch {
      // keep the original failure
    }
    throw error;
  }
  for (const frame of frames) {
    if (frame.path === null) continue;
    try {
      removeOwnedFrame(dataDir, frame.path);
    } catch {
      // A stale or externally removed frame file must not block the rerun.
    }
  }
  return frames;
}

async function listVideos(root: string, recursive: boolean): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      const link = await lstat(path);
      if (link.isSymbolicLink()) {
        let followed;
        try {
          followed = await stat(path);
        } catch {
          continue;
        }
        if (followed.isDirectory()) continue;
        if (followed.isFile()) found.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        if (recursive) await walk(path);
        continue;
      }
      if (entry.isFile()) found.push(path);
    }
  };
  await walk(root);
  found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return found;
}

function isVideoName(file: string): boolean {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.includes(file.slice(dot).toLowerCase());
}

interface ProbeSource {
  url: string;
  family: string;
}

export function sourceFromProbe(probeJson: string): ProbeSource {
  try {
    const parsed = JSON.parse(probeJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { url: '', family: '' };
    const source = (parsed as { source?: unknown }).source;
    if (typeof source !== 'object' || source === null) return { url: '', family: '' };
    const record = source as { url?: unknown; family?: unknown };
    return {
      url: typeof record.url === 'string' ? record.url : '',
      family: typeof record.family === 'string' ? record.family : '',
    };
  } catch {
    return { url: '', family: '' };
  }
}

export function withDuration(probeJson: string, duration: number): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(probeJson) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed.duration = duration;
  return JSON.stringify(parsed);
}

export function durationFromProbe(probeJson: string): number | null {
  try {
    const parsed = JSON.parse(probeJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const duration = (parsed as { duration?: unknown }).duration;
    return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

function rememberCsvError(db: LocalFramesDatabase, taskId: string, errors: IngestReport['csvErrors']): void {
  if (errors.length === 0) return;
  const row = db.raw.prepare('SELECT progress_json FROM tasks WHERE task_id = ?').get(taskId) as
    | { progress_json?: string }
    | undefined;
  let progress: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row?.progress_json ?? '{}') as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) progress = parsed as Record<string, unknown>;
  } catch {
    progress = {};
  }
  const current = Array.isArray(progress.csvErrors) ? progress.csvErrors : [];
  progress.csvErrors = [...current, ...errors];
  db.raw.prepare('UPDATE tasks SET progress_json = ?, updated_at = ? WHERE task_id = ?').run(
    JSON.stringify(progress),
    nowIso(),
    taskId,
  );
}

/**
 * Insert local videos into one task. The same bytes stay a single row.
 * Files are hashed with a read-only stream and are never moved or rewritten.
 *
 * Issue #7: unless `force` is set, bytes already framed and labelled by an
 * earlier task are inserted as SKIPPED, so no frame is extracted and no model
 * call is made for them.
 */
export async function ingestPaths(
  db: LocalFramesDatabase,
  taskId: string,
  dataDir: string,
  allowRoots: readonly string[],
  inputs: readonly { path: string; recursive: boolean }[],
  options: IngestOptions = {},
): Promise<IngestReport> {
  const force = options.force === true;
  const report: IngestReport = { added: [], skipped: [], rerun: [], existing: [], rejected: [], csvErrors: [] };
  const csvCache = new Map<string, CsvTable | null>();
  const files: string[] = [];
  for (const input of inputs) {
    let validated;
    try {
      validated = await validateVideoPath(input.path, { allowRoots });
    } catch (error) {
      if (error instanceof InputError) {
        report.rejected.push({ path: input.path, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
    if (validated.kind === 'file') {
      files.push(validated.localPath);
      continue;
    }
    const listed = await listVideos(validated.localPath, input.recursive);
    for (const candidate of listed) {
      if (!isVideoName(candidate)) continue;
      files.push(candidate);
    }
  }

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    let validated;
    try {
      validated = await validateVideoPath(file, { allowRoots });
    } catch (error) {
      if (error instanceof InputError) {
        report.rejected.push({ path: file, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
    if (validated.kind !== 'file') continue;
    const digest = await sha256File(validated.localPath);
    const elsewhere = usedElsewhere(db, digest, taskId);
    const existing = db.raw
      .prepare('SELECT item_id, local_path FROM items WHERE task_id = ? AND file_sha256 = ?')
      .get(taskId, digest) as { item_id?: string; local_path?: string } | undefined;
    if (typeof existing?.item_id === 'string') {
      if (!force) {
        report.existing.push({
          itemId: existing.item_id,
          localPath: typeof existing.local_path === 'string' ? existing.local_path : validated.localPath,
          fileSha256: digest,
          usedElsewhere: false,
        });
        continue;
      }
      resetItemForRerun(db, dataDir, existing.item_id);
      const meta = await metadataForFile(validated.localPath, dataDir, csvCache, report.csvErrors);
      db.raw
        .prepare(
          `UPDATE items SET
             local_path = ?, file_sha256 = ?, file_bytes = ?, title = ?, author = ?, license_raw = ?,
             region = ?, region_evidence = ?, probe_json = ?, state = 'NEW', error_code = NULL,
             attempts = 0, updated_at = ?
           WHERE item_id = ?`,
        )
        .run(
          validated.localPath,
          digest,
          validated.bytes,
          basename(validated.localPath),
          meta.author,
          meta.license,
          meta.region,
          meta.regionEvidence,
          probeJsonFor(meta),
          nowIso(),
          existing.item_id,
        );
      report.rerun.push({
        itemId: existing.item_id,
        localPath: validated.localPath,
        fileSha256: digest,
        usedElsewhere: elsewhere,
        forced: true,
      });
      continue;
    }
    const skip = previouslyProcessed(db, digest, taskId) && !force;
    const meta = await metadataForFile(validated.localPath, dataDir, csvCache, report.csvErrors);
    const itemId = newId();
    const now = nowIso();
    db.raw
      .prepare(
        `INSERT INTO items (
          item_id, task_id, local_path, file_sha256, file_bytes, title, author, license_raw,
          region, region_evidence, probe_json, state, error_code, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(
        itemId,
        taskId,
        validated.localPath,
        digest,
        validated.bytes,
        basename(validated.localPath),
        meta.author,
        meta.license,
        meta.region,
        meta.regionEvidence,
        probeJsonFor(meta),
        skip ? 'SKIPPED' : 'NEW',
        now,
        now,
      );
    const item: IngestedItem = {
      itemId,
      localPath: validated.localPath,
      fileSha256: digest,
      usedElsewhere: elsewhere,
    };
    if (skip) report.skipped.push(item);
    else report.added.push(item);
  }
  rememberCsvError(db, taskId, report.csvErrors);
  return report;
}

/** Items added to the task in this call, including skips and forced reruns. */
export function acceptedCount(report: IngestReport): number {
  return report.added.length + report.skipped.length + report.rerun.length;
}

export function describeIngest(report: IngestReport): string {
  const parts = [`新增 ${report.added.length}`];
  if (report.skipped.length > 0) parts.push(`跳过 ${report.skipped.length}（先前已处理）`);
  if (report.rerun.length > 0) parts.push(`强制重跑 ${report.rerun.length}`);
  if (report.existing.length > 0) parts.push(`已存在 ${report.existing.length}`);
  if (report.rejected.length > 0) parts.push(`拒绝 ${report.rejected.length}`);
  if (report.csvErrors.length > 0) parts.push(`CSV 解析失败 ${report.csvErrors.length}`);
  return parts.join('，');
}
