import { removeOwnedFrame } from './cleanup.js';
import type { LocalFramesDatabase } from './db.js';
import { nowIso } from './ids.js';
import { durationFromProbe } from './ingest.js';
import { readProgress, writeProgress } from './progress.js';
import type { RetryResult } from './types.js';

/**
 * Pauses that the user cannot retry from the page: credentials, quota and a
 * missing LLM service need an external fix first. A manual retry must explain
 * this instead of silently clearing the pause.
 */
const NON_RETRYABLE_PAUSE_CODES: Record<string, string> = {
  MODEL_CREDENTIAL: '模型凭据无效或缺失',
  MODEL_QUOTA: '模型调用额度已用尽',
  NO_LLM: '当前没有可用的模型服务',
};

export class RetryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RetryError';
    this.status = status;
    this.code = code;
  }
}

export interface RetrySelection {
  /** Failed videos to retry; each must be in the ERROR state. */
  itemIds?: readonly string[];
  /** Failed frames to retry; each must be in the FAILED state. */
  frameIds?: readonly string[];
  /** Retry every failed video and frame of the task. */
  all?: boolean;
}

interface ItemRow {
  item_id: string;
  state: string;
  probe_json: string;
}

interface FrameRow {
  frame_id: string;
  item_id: string;
  path: string | null;
}

interface TaskRow {
  task_id: string;
  status: string;
  progress_json: string;
}

interface RetriedFrame {
  frame_id: string;
  path: string | null;
}

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(',');
}

function loadItems(db: LocalFramesDatabase, taskId: string): ItemRow[] {
  return db.raw
    .prepare('SELECT item_id, state, probe_json FROM items WHERE task_id = ?')
    .all(taskId) as unknown as ItemRow[];
}

function loadFailedFrames(db: LocalFramesDatabase, taskId: string): FrameRow[] {
  return db.raw
    .prepare(
      `SELECT frames.frame_id, frames.item_id, frames.path
       FROM frames JOIN items ON items.item_id = frames.item_id
       WHERE items.task_id = ? AND frames.state = 'FAILED'`,
    )
    .all(taskId) as unknown as FrameRow[];
}

function otherActiveTask(db: LocalFramesDatabase, taskId: string): string | null {
  const row = db.raw
    .prepare(
      "SELECT task_id FROM tasks WHERE status IN ('RUNNING', 'PAUSED') AND task_id != ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(taskId) as { task_id?: string } | undefined;
  return typeof row?.task_id === 'string' ? row.task_id : null;
}

/**
 * Manually retry failed videos and frames of one task.
 *
 * A retried video goes back to NEW/PROBED (depending on its stored probe) and
 * its FAILED frames are dropped so the same timestamps are extracted again. A
 * retried frame row is dropped; its video is also reset to PROBED so the state
 * machine re-extracts that timestamp and judges it again. Calls are historical
 * facts: they stay attached to the task so the budget and statistics keep
 * counting the replaced batch. Finished frames, labels and the user's original
 * videos are not touched.
 */
export function retryTaskFailures(
  db: LocalFramesDatabase,
  dataDir: string,
  taskId: string,
  selection: RetrySelection,
  now: Date = new Date(),
): RetryResult {
  const task = db.raw
    .prepare('SELECT task_id, status, progress_json FROM tasks WHERE task_id = ?')
    .get(taskId) as TaskRow | undefined;
  if (task === undefined) throw new RetryError(404, 'NOT_FOUND', '任务不存在');

  const allItems = loadItems(db, taskId);
  const allFailedFrames = loadFailedFrames(db, taskId);
  const byItem = new Map(allItems.map((item) => [item.item_id, item]));
  const byFrame = new Map(allFailedFrames.map((frame) => [frame.frame_id, frame]));
  const skipped: RetryResult['skipped'] = [];

  let retriedItems: ItemRow[] = [];
  const requestedItems = selection.itemIds ?? [];
  if (selection.all === true) {
    retriedItems = allItems.filter((item) => item.state === 'ERROR');
  } else {
    for (const itemId of requestedItems) {
      const item = byItem.get(itemId);
      if (item === undefined) skipped.push({ id: itemId, kind: 'item', reason: '视频不存在' });
      else if (item.state !== 'ERROR') skipped.push({ id: itemId, kind: 'item', reason: `不是失败状态（${item.state}）` });
      else retriedItems.push(item);
    }
  }

  let retriedFrames: FrameRow[] = [];
  const requestedFrames = selection.frameIds ?? [];
  if (selection.all === true) {
    retriedFrames = allFailedFrames;
  } else {
    for (const frameId of requestedFrames) {
      const frame = byFrame.get(frameId);
      if (frame === undefined) skipped.push({ id: frameId, kind: 'frame', reason: '失败帧不存在' });
      else retriedFrames.push(frame);
    }
  }

  if (retriedItems.length === 0 && retriedFrames.length === 0) {
    throw new RetryError(409, 'NOTHING_TO_RETRY', '没有可重试的失败项');
  }

  const pauseCode = readProgress(task.progress_json).pauseCode;
  const nonRetryable = pauseCode === null ? undefined : NON_RETRYABLE_PAUSE_CODES[pauseCode];
  if (nonRetryable !== undefined) {
    const reason = readProgress(task.progress_json).pauseReason ?? nonRetryable;
    throw new RetryError(
      409,
      'NOT_RETRYABLE',
      `当前暂停原因不可重试：${reason}。请先在 DSH 模型页处理，再用“继续”恢复任务。`,
    );
  }
  if (task.status === 'CANCELLED') {
    throw new RetryError(409, 'BAD_STATE', '已取消的任务不能重试失败项');
  }
  if (task.status !== 'RUNNING' && task.status !== 'PAUSED' && task.status !== 'DONE') {
    throw new RetryError(409, 'BAD_STATE', `任务状态不允许重试（${task.status}）`);
  }
  if (task.status === 'DONE' && otherActiveTask(db, taskId) !== null) {
    throw new RetryError(409, 'TASK_ACTIVE', '已有进行中或暂停的任务，完成或取消后再重试该任务的失败项');
  }

  // Videos reset by a frame retry are derived from the frame rows before any
  // row is deleted, so the state machine can re-extract the missing timestamps.
  const retriedFrameIds = new Set(retriedFrames.map((frame) => frame.frame_id));
  const targetItemIds = new Set(retriedItems.map((item) => item.item_id));
  const itemIdsFromFrames = new Set(retriedFrames.map((frame) => frame.item_id));
  for (const itemId of itemIdsFromFrames) targetItemIds.add(itemId);

  // Everything the task still records as FAILED for a retried video is dropped
  // so its failed timestamps can be extracted again. Existing JUDGED frames stay.
  const framesToDelete: RetriedFrame[] = [];
  const seenFrames = new Set<string>();
  const addFrameToDelete = (frame: { frame_id: string; path: string | null }): void => {
    if (seenFrames.has(frame.frame_id)) return;
    seenFrames.add(frame.frame_id);
    framesToDelete.push({ frame_id: frame.frame_id, path: frame.path });
  };
  for (const frame of retriedFrames) addFrameToDelete(frame);
  for (const itemId of targetItemIds) {
    for (const frame of allFailedFrames) {
      if (frame.item_id === itemId) addFrameToDelete(frame);
    }
  }

  const timestamp = nowIso(now);
  db.raw.exec('BEGIN IMMEDIATE');
  try {
    for (const frame of framesToDelete) {
      // Calls stay: they are the task's spent budget and call statistics.
      db.raw.prepare('DELETE FROM labels WHERE frame_id = ?').run(frame.frame_id);
      db.raw.prepare('DELETE FROM frames WHERE frame_id = ?').run(frame.frame_id);
    }
    for (const itemId of targetItemIds) {
      const item = byItem.get(itemId);
      if (item === undefined) continue;
      const nextState = durationFromProbe(item.probe_json) === null ? 'NEW' : 'PROBED';
      db.raw
        .prepare("UPDATE items SET state = ?, error_code = NULL, updated_at = ? WHERE item_id = ?")
        .run(nextState, timestamp, itemId);
    }

    const progress = readProgress(task.progress_json);
    if (task.status !== 'RUNNING') {
      progress.pauseCode = null;
      progress.pauseReason = null;
      progress.retryAt = null;
      progress.gap = null;
      progress.report = null;
      progress.consecutiveCallFailures = 0;
      progress.consecutiveOutputFailures = 0;
      writeProgress(db, taskId, progress, now);
    }
    db.raw.prepare("UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE task_id = ?").run(timestamp, taskId);
    db.raw.exec('COMMIT');
  } catch (error) {
    try {
      db.raw.exec('ROLLBACK');
    } catch {
      // keep the original failure
    }
    throw error;
  }

  for (const frame of framesToDelete) {
    if (frame.path === null) continue;
    try {
      removeOwnedFrame(dataDir, frame.path);
    } catch {
      // A stale or externally removed frame file must not undo the retry.
    }
  }

  return {
    task_id: taskId,
    task_status: 'RUNNING',
    items_retried: retriedItems.map((item) => item.item_id),
    frames_retried: [...retriedFrameIds],
    skipped,
  };
}
