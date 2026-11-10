import { mkdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { removeOwnedFrame } from './cleanup.js';
import type { LocalFramesDatabase } from './db.js';
import { dhashFromGray, frameCount, frameTimestampsMs, hammingHex, DHASH_DISTANCE_MAX } from './dhash.js';
import { DEFAULT_MIN_FREE_DISK_GB, directorySizeBytes, freeDiskGb } from './disk.js';
import { durationFromProbe, withDuration } from './ingest.js';
import { newId, nowIso } from './ids.js';
import { judgeBatch, TaskPause, TaskStopped, type JudgeAttempt } from './judge.js';
import { readJpegInfo, type MediaClient } from './media.js';
import { chunkObjects, outcomeFor, type PromptObject } from './prompt.js';
import {
  CALL_FAIL_LIMIT,
  MODEL_RETRY_MS,
  OUTPUT_FAIL_LIMIT,
  readProgress,
  readSpec,
  writeProgress,
  type TaskProgress,
} from './progress.js';
import type { SettingsStore } from './settings.js';
import type { Outcome, Verdict, Visibility } from './types.js';
import type { VisionClient } from './vision.js';

export interface PipelineDeps {
  db: LocalFramesDatabase;
  settings: SettingsStore;
  dataDir: string;
  media: MediaClient;
  vision: VisionClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
  minFreeGb?: number;
}

interface TaskRecord {
  task_id: string;
  spec_json: string;
  progress_json: string;
  status: string;
}

interface ItemRecord {
  item_id: string;
  task_id: string;
  local_path: string;
  state: string;
  probe_json: string;
  attempts: number;
}

type StepResult = 'worked' | 'idle' | 'paused';

interface KeptFrame {
  frame_id: string;
  dhash: string;
}

/** Remove tmp on startup. Frame files and the database stay. */
export async function clearTmp(dataDir: string): Promise<void> {
  const tmp = join(dataDir, 'tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await mkdir(join(dataDir, 'frames'), { recursive: true });
  await mkdir(join(dataDir, 'exports'), { recursive: true });
}

export class Pipeline {
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly credentialRetry = { used: false };

  constructor(private readonly deps: PipelineDeps) {}

  stop(): void {
    this.stopped = true;
  }

  /** Schedule a pass. Overlapping kicks share one chain. */
  kick(): void {
    this.chain = this.chain
      .then(() => this.runUntilBlocked())
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log?.(`状态机异常：${message}`);
      });
  }

  /** Resolves when the current kick chain is idle. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  async runUntilIdle(): Promise<void> {
    this.kick();
    await this.chain;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async runUntilBlocked(): Promise<void> {
    for (let guard = 0; guard < 100_000; guard += 1) {
      if (this.stopped) return;
      const step = await this.step();
      if (step !== 'worked') return;
    }
    throw new Error('状态机步数超过上限');
  }

  private async step(): Promise<StepResult> {
    const task = this.claimTask();
    if (task === null) return 'idle';
    if (task.status !== 'RUNNING') return 'paused';
    try {
      return await this.advance(task);
    } catch (error) {
      if (error instanceof TaskStopped) return 'idle';
      if (error instanceof TaskPause) {
        this.applyPause(task.task_id, error);
        return 'paused';
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log?.(`状态机异常：${message}`);
      this.applyPause(task.task_id, new TaskPause('INTERNAL', message));
      return 'paused';
    }
  }

  private claimTask(): TaskRecord | null {
    const running = this.taskByStatus('RUNNING');
    if (running !== null) return running;
    const paused = this.taskByStatus('PAUSED');
    if (paused === null) return null;
    const progress = readProgress(paused.progress_json);
    const due =
      progress.pauseCode === 'MODEL_FAILURES' &&
      progress.retryAt !== null &&
      Date.parse(progress.retryAt) <= this.now().getTime();
    if (!due) return paused;
    progress.pauseCode = null;
    progress.pauseReason = null;
    progress.retryAt = null;
    progress.consecutiveCallFailures = 0;
    writeProgress(this.deps.db, paused.task_id, progress, this.now());
    this.deps.db.raw
      .prepare("UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE task_id = ?")
      .run(nowIso(this.now()), paused.task_id);
    return this.taskById(paused.task_id);
  }

  private taskByStatus(status: string): TaskRecord | null {
    const row = this.deps.db.raw
      .prepare(
        'SELECT task_id, spec_json, progress_json, status FROM tasks WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(status) as TaskRecord | undefined;
    return row ?? null;
  }

  private taskById(taskId: string): TaskRecord | null {
    const row = this.deps.db.raw
      .prepare('SELECT task_id, spec_json, progress_json, status FROM tasks WHERE task_id = ?')
      .get(taskId) as TaskRecord | undefined;
    return row ?? null;
  }

  private applyPause(taskId: string, error: TaskPause): void {
    const task = this.taskById(taskId);
    if (task === null) return;
    const progress = readProgress(task.progress_json);
    progress.pauseCode = error.code;
    progress.pauseReason = error.message;
    progress.gap = error.gap;
    if (error.code === 'MODEL_FAILURES' && progress.retryAt === null) {
      progress.retryAt = new Date(this.now().getTime() + MODEL_RETRY_MS).toISOString();
    }
    writeProgress(this.deps.db, taskId, progress, this.now());
    this.deps.db.raw
      .prepare("UPDATE tasks SET status = 'PAUSED', updated_at = ? WHERE task_id = ?")
      .run(nowIso(this.now()), taskId);
    this.deps.log?.(`任务暂停：${error.message}`);
  }

  private assertRunning(taskId: string): void {
    const task = this.taskById(taskId);
    if (task === null || task.status !== 'RUNNING') throw new TaskStopped();
  }

  private assertCapacity(taskId: string): void {
    this.assertRunning(taskId);
    const minFree = this.deps.minFreeGb ?? DEFAULT_MIN_FREE_DISK_GB;
    const free = freeDiskGb(this.deps.dataDir);
    if (free !== null && free < minFree) {
      throw new TaskPause('DISK_LOW', `磁盘剩余 ${free.toFixed(1)} GB，低于 ${minFree} GB`, {
        freeGb: free,
        minFreeGb: minFree,
      });
    }
    const settings = this.deps.settings.load();
    const used = directorySizeBytes(this.deps.dataDir);
    if (used > settings.dataDirLimitGb * 1e9) {
      throw new TaskPause('DATA_DIR_LIMIT', '数据目录超过设置上限', {
        usedBytes: used,
        limitGb: settings.dataDirLimitGb,
      });
    }
  }

  private callCount(taskId: string): number {
    const row = this.deps.db.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM calls
         JOIN frames ON frames.frame_id = calls.frame_id
         JOIN items ON items.item_id = frames.item_id
         WHERE items.task_id = ?`,
      )
      .get(taskId) as { count?: number } | undefined;
    return typeof row?.count === 'number' ? row.count : 0;
  }

  private assertBudget(taskId: string): void {
    const settings = this.deps.settings.load();
    const budget = settings.budgetPerTask;
    const used = this.callCount(taskId);
    if (used >= budget) {
      throw new TaskPause('BUDGET', `模型调用预算已用尽（${used}/${budget}）`, { used, budget });
    }
  }

  private async advance(task: TaskRecord): Promise<StepResult> {
    this.assertCapacity(task.task_id);
    const item = this.deps.db.raw
      .prepare(
        `SELECT item_id, task_id, local_path, state, probe_json, attempts FROM items
         WHERE task_id = ? AND state IN ('NEW', 'PROBED', 'FRAMED')
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(task.task_id) as ItemRecord | undefined;
    if (item === undefined) {
      this.finishTask(task.task_id);
      return 'idle';
    }
    if (item.state === 'NEW') {
      await this.probe(item);
      return 'worked';
    }
    if (item.state === 'PROBED') {
      await this.extractOne(task, item);
      return 'worked';
    }
    await this.judgeOne(task, item);
    return 'worked';
  }

  private probe(item: ItemRecord): Promise<void> {
    return this.deps.media.probeDuration(item.local_path).then((result) => {
      const now = nowIso(this.now());
      if (!result.ok) {
        this.deps.db.raw
          .prepare(
            `UPDATE items SET state = 'ERROR', error_code = 'PROBE_FAILED', attempts = attempts + 1, updated_at = ? WHERE item_id = ?`,
          )
          .run(now, item.item_id);
        return;
      }
      this.deps.db.raw
        .prepare(
          `UPDATE items SET state = 'PROBED', probe_json = ?, attempts = attempts + 1, error_code = NULL, updated_at = ? WHERE item_id = ?`,
        )
        .run(withDuration(item.probe_json, result.duration), now, item.item_id);
    });
  }

  private async extractOne(task: TaskRecord, item: ItemRecord): Promise<void> {
    const duration = durationFromProbe(item.probe_json);
    if (duration === null) {
      this.failItem(item.item_id, 'PROBE_FAILED');
      return;
    }
    const spec = readSpec(task.spec_json);
    const count = frameCount(duration, spec.frameIntervalSeconds);
    const stamps = frameTimestampsMs(duration, count);
    const existing = new Set(
      (
        this.deps.db.raw.prepare('SELECT t_ms FROM frames WHERE item_id = ?').all(item.item_id) as Array<{ t_ms: number }>
      ).map((row) => row.t_ms),
    );
    const next = stamps.find((stamp) => !existing.has(stamp));
    if (next === undefined) {
      this.deps.db.raw
        .prepare("UPDATE items SET state = 'FRAMED', updated_at = ? WHERE item_id = ?")
        .run(nowIso(this.now()), item.item_id);
      return;
    }
    const frameId = newId();
    const dest = join(this.deps.dataDir, 'frames', task.task_id, `${frameId}.jpg`);
    const extracted = await this.deps.media.extractFrame(item.local_path, next / 1000, dest);
    if (!extracted.ok) {
      this.noteFrameFailure(item, next, null, `取帧失败：${extracted.error}`);
      return;
    }
    const pgm = join(this.deps.dataDir, 'tmp', `${frameId}.pgm`);
    const gray = await this.deps.media.decodeGray(dest, pgm);
    await unlink(pgm).catch(() => undefined);
    if (!gray.ok) {
      removeOwnedFrame(this.deps.dataDir, dest);
      this.noteFrameFailure(item, next, null, `灰度解码失败：${gray.error}`);
      return;
    }
    const dhash = dhashFromGray(gray.raster.pixels, gray.raster.width, gray.raster.height);
    const duplicateOf = this.findDuplicate(task.task_id, dhash);
    const info = readJpegInfo(dest);
    const now = nowIso(this.now());
    if (duplicateOf !== null) {
      removeOwnedFrame(this.deps.dataDir, dest);
      this.deps.db.raw
        .prepare(
          `INSERT INTO frames (
            frame_id, item_id, t_ms, path, width, height, dhash, duplicate_of, judge_json, state, error, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'DUPLICATE', NULL, ?, ?)`,
        )
        .run(frameId, item.item_id, next, info?.width ?? null, info?.height ?? null, dhash, duplicateOf, now, now);
      return;
    }
    this.deps.db.raw
      .prepare(
        `INSERT INTO frames (
          frame_id, item_id, t_ms, path, width, height, dhash, duplicate_of, judge_json, state, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'PENDING', NULL, ?, ?)`,
      )
      .run(frameId, item.item_id, next, dest, info?.width ?? null, info?.height ?? null, dhash, now, now);
  }

  private noteFrameFailure(item: ItemRecord, tMs: number, dhash: string | null, error: string): void {
    const now = nowIso(this.now());
    const frameId = newId();
    this.deps.db.raw
      .prepare(
        `INSERT INTO frames (
          frame_id, item_id, t_ms, path, width, height, dhash, duplicate_of, judge_json, state, error, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, 'FAILED', ?, ?, ?)`,
      )
      .run(frameId, item.item_id, tMs, dhash, error, now, now);
    const failed = this.deps.db.raw
      .prepare(
        `SELECT COUNT(*) AS count FROM frames
         WHERE item_id = ? AND state = 'FAILED' AND (error LIKE '取帧失败%' OR error LIKE '灰度解码失败%')`,
      )
      .get(item.item_id) as { count?: number } | undefined;
    if ((failed?.count ?? 0) >= 3) this.failItem(item.item_id, 'FRAME_FAILED');
  }

  private failItem(itemId: string, code: string): void {
    this.deps.db.raw
      .prepare("UPDATE items SET state = 'ERROR', error_code = ?, attempts = attempts + 1, updated_at = ? WHERE item_id = ?")
      .run(code, nowIso(this.now()), itemId);
  }

  private findDuplicate(taskId: string, dhash: string): string | null {
    const kept = this.deps.db.raw
      .prepare(
        `SELECT frames.frame_id, frames.dhash FROM frames
         JOIN items ON items.item_id = frames.item_id
         WHERE items.task_id = ? AND frames.state != 'DUPLICATE' AND frames.dhash IS NOT NULL
         ORDER BY items.created_at ASC, items.rowid ASC, frames.t_ms ASC, frames.rowid ASC`,
      )
      .all(taskId) as unknown as KeptFrame[];
    for (const frame of kept) {
      if (hammingHex(dhash, frame.dhash) <= DHASH_DISTANCE_MAX) return frame.frame_id;
    }
    return null;
  }

  private async judgeOne(task: TaskRecord, item: ItemRecord): Promise<void> {
    const frame = this.deps.db.raw
      .prepare(
        `SELECT frame_id, path FROM frames
         WHERE item_id = ? AND state = 'PENDING' AND path IS NOT NULL
         ORDER BY t_ms ASC, rowid ASC LIMIT 1`,
      )
      .get(item.item_id) as { frame_id: string; path: string } | undefined;
    if (frame === undefined) {
      this.deps.db.raw
        .prepare("UPDATE items SET state = 'DONE', updated_at = ? WHERE item_id = ?")
        .run(nowIso(this.now()), item.item_id);
      return;
    }
    const spec = readSpec(task.spec_json);
    const settings = this.deps.settings.load();
    const model = settings.model ?? spec.model;
    if (model === null) throw new TaskPause('NO_MODEL', '未选择模型');
    const targets = this.loadObjects(spec.targetIds);
    if (targets.length === 0) throw new TaskPause('NO_TARGET', '任务没有可判断的对象');
    const batches = chunkObjects(targets);
    const accepted: Array<{ object: PromptObject; verdict: Verdict; visibility: Visibility; confidence: number; reason: string }> = [];
    const modelName = `${model.provider}/${model.model}`.slice(0, 200);
    for (const batch of batches) {
      const result = await judgeBatch({
        vision: this.deps.vision,
        provider: model.provider,
        model: model.model,
        objects: batch,
        imagePath: frame.path,
        taskId: task.task_id,
        sleep: (ms) => this.sleep(ms),
        beforeCall: () => {
          this.assertBudget(task.task_id);
          this.assertCapacity(task.task_id);
        },
        onAttempt: (attempt) => this.insertCall(frame.frame_id, modelName, attempt),
        credentialRetry: this.credentialRetry,
      });
      if (!result.ok) {
        if (result.reason === 'format') {
          this.failModelFrame(task.task_id, frame.frame_id, frame.path, result.message);
        } else {
          this.noteCallStreak(task.task_id);
        }
        return;
      }
      for (const object of result.objects) {
        const source = batch.find((entry) => entry.name === object.name);
        if (source === undefined) continue;
        accepted.push({
          object: source,
          verdict: object.verdict,
          visibility: object.visibility,
          confidence: object.confidence,
          reason: object.reason,
        });
      }
    }
    this.commitLabels(task.task_id, frame.frame_id, frame.path, accepted);
  }

  private loadObjects(targetIds: readonly string[]): PromptObject[] {
    if (targetIds.length === 0) return [];
    const rows = this.deps.db.raw
      .prepare(
        `SELECT target_id, name, aliases_json, definition FROM targets WHERE target_id IN (${targetIds.map(() => '?').join(',')})`,
      )
      .all(...targetIds) as Array<{ target_id: string; name: string; aliases_json: string; definition: string }>;
    const byId = new Map(rows.map((row) => [row.target_id, row]));
    const objects: Array<PromptObject & { target_id: string }> = [];
    for (const id of targetIds) {
      const row = byId.get(id);
      if (row === undefined || row.definition.trim().length === 0) continue;
      let aliases: PromptObject['aliases'] = {};
      try {
        const parsed = JSON.parse(row.aliases_json) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          aliases = {};
          for (const [language, value] of Object.entries(parsed)) {
            if (Array.isArray(value)) aliases[language] = value.filter((entry): entry is string => typeof entry === 'string');
          }
        }
      } catch {
        aliases = {};
      }
      objects.push({ target_id: id, name: row.name, aliases, definition: row.definition });
    }
    return objects;
  }

  private insertCall(frameId: string, model: string, attempt: JudgeAttempt): void {
    this.deps.db.raw
      .prepare(
        'INSERT INTO calls (call_id, frame_id, model, ms, tokens, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId(),
        frameId,
        model,
        attempt.ms,
        attempt.tokens,
        attempt.ok ? 1 : 0,
        attempt.error,
        nowIso(this.now()),
      );
  }

  private mutateProgress(taskId: string, change: (progress: TaskProgress) => void): void {
    const task = this.taskById(taskId);
    if (task === null) return;
    const progress = readProgress(task.progress_json);
    change(progress);
    writeProgress(this.deps.db, taskId, progress, this.now());
  }

  private noteCallStreak(taskId: string): void {
    let pause: TaskPause | null = null;
    this.mutateProgress(taskId, (progress) => {
      progress.consecutiveCallFailures += 1;
      if (progress.consecutiveCallFailures >= CALL_FAIL_LIMIT) {
        progress.retryAt = new Date(this.now().getTime() + MODEL_RETRY_MS).toISOString();
        pause = new TaskPause('MODEL_FAILURES', '模型连续调用失败，任务已暂停，每 10 分钟自动重试');
      }
    });
    if (pause !== null) throw pause;
  }

  private failModelFrame(taskId: string, frameId: string, framePath: string, message: string): void {
    removeOwnedFrame(this.deps.dataDir, framePath);
    this.deps.db.raw
      .prepare("UPDATE frames SET state = 'FAILED', path = NULL, error = ?, updated_at = ? WHERE frame_id = ?")
      .run(`模型输出不合法：${message}`, nowIso(this.now()), frameId);
    let pause: TaskPause | null = null;
    this.mutateProgress(taskId, (progress) => {
      progress.consecutiveOutputFailures += 1;
      progress.consecutiveCallFailures = 0;
      if (progress.consecutiveOutputFailures >= OUTPUT_FAIL_LIMIT) {
        pause = new TaskPause('MODEL_OUTPUT', '模型输出格式不对');
      }
    });
    if (pause !== null) throw pause;
  }

  private commitLabels(
    taskId: string,
    frameId: string,
    framePath: string,
    labels: Array<{ object: PromptObject & { target_id?: string }; verdict: Verdict; visibility: Visibility; confidence: number; reason: string }>,
  ): void {
    const call = this.deps.db.raw
      .prepare("SELECT call_id FROM calls WHERE frame_id = ? AND ok = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(frameId) as { call_id?: string } | undefined;
    const callId = call?.call_id;
    if (typeof callId !== 'string') throw new TaskPause('INTERNAL', '没有成功的模型调用，不能写入标签');
    const now = nowIso(this.now());
    let qualified = false;
    this.deps.db.raw.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.deps.db.raw.prepare(
        `INSERT INTO labels (frame_id, target_id, verdict, visibility, confidence, reason, outcome, call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const judge = labels.map((label) => ({
        name: label.object.name,
        verdict: label.verdict,
        visibility: label.visibility,
        confidence: label.confidence,
        reason: label.reason,
      }));
      for (const label of labels) {
        const targetId = (label.object as { target_id?: string }).target_id;
        if (typeof targetId !== 'string') continue;
        const outcome = outcomeFor(label.verdict, label.visibility);
        if (outcome === 'QUALIFIED') qualified = true;
        insert.run(frameId, targetId, label.verdict, label.visibility, label.confidence, label.reason, outcome, callId, now);
      }
      this.deps.db.raw
        .prepare("UPDATE frames SET state = 'JUDGED', judge_json = ?, updated_at = ? WHERE frame_id = ?")
        .run(JSON.stringify({ objects: judge }), now, frameId);
      this.deps.db.raw.exec('COMMIT');
    } catch (error) {
      try {
        this.deps.db.raw.exec('ROLLBACK');
      } catch {
        // 保留原始错误
      }
      throw error;
    }
    if (!qualified) removeOwnedFrame(this.deps.dataDir, framePath);
    if (!qualified) {
      this.deps.db.raw.prepare('UPDATE frames SET path = NULL, updated_at = ? WHERE frame_id = ?').run(nowIso(this.now()), frameId);
    }
    this.mutateProgress(taskId, (progress) => {
      progress.consecutiveCallFailures = 0;
      progress.consecutiveOutputFailures = 0;
    });
  }

  private finishTask(taskId: string): void {
    const counts = this.deps.db.raw
      .prepare(
        `SELECT targets.name AS name, labels.outcome AS outcome, COUNT(*) AS count
         FROM labels
         JOIN targets ON targets.target_id = labels.target_id
         JOIN frames ON frames.frame_id = labels.frame_id
         JOIN items ON items.item_id = frames.item_id
         WHERE items.task_id = ?
         GROUP BY targets.name, labels.outcome`,
      )
      .all(taskId) as Array<{ name: string; outcome: string; count: number }>;
    const errors = this.deps.db.raw
      .prepare("SELECT local_path, error_code FROM items WHERE task_id = ? AND state = 'ERROR' ORDER BY created_at ASC")
      .all(taskId) as Array<{ local_path: string; error_code: string | null }>;
    this.mutateProgress(taskId, (progress) => {
      progress.report = {
        modelCalls: this.callCount(taskId),
        outcomes: counts,
        errors,
      };
      progress.pauseCode = null;
      progress.pauseReason = null;
    });
    this.deps.db.raw
      .prepare("UPDATE tasks SET status = 'DONE', updated_at = ? WHERE task_id = ? AND status = 'RUNNING'")
      .run(nowIso(this.now()), taskId);
  }
}

export interface ControlResult {
  ok: boolean;
  message: string;
  status?: string;
}

/** Pause, resume (retry ERROR files), or cancel. Illegal transitions return ok: false. */
export function controlTask(db: LocalFramesDatabase, dataDir: string, taskId: string, action: string, now: Date = new Date()): ControlResult {
  const task = db.raw.prepare('SELECT task_id, status, progress_json FROM tasks WHERE task_id = ?').get(taskId) as
    | { task_id: string; status: string; progress_json: string }
    | undefined;
  if (task === undefined) return { ok: false, message: '任务不存在' };
  if (action === 'pause') {
    if (task.status !== 'RUNNING') return { ok: false, message: '状态不允许' };
    const progress = readProgress(task.progress_json);
    progress.pauseCode = 'USER';
    progress.pauseReason = '用户暂停';
    progress.retryAt = null;
    writeProgress(db, taskId, progress, now);
    db.raw.prepare("UPDATE tasks SET status = 'PAUSED', updated_at = ? WHERE task_id = ?").run(nowIso(now), taskId);
    return { ok: true, message: '已暂停', status: 'PAUSED' };
  }
  if (action === 'resume') {
    if (task.status !== 'PAUSED') return { ok: false, message: '状态不允许' };
    const progress = readProgress(task.progress_json);
    progress.pauseCode = null;
    progress.pauseReason = null;
    progress.retryAt = null;
    progress.gap = null;
    progress.consecutiveCallFailures = 0;
    progress.consecutiveOutputFailures = 0;
    writeProgress(db, taskId, progress, now);
    const errors = db.raw
      .prepare("SELECT item_id, probe_json FROM items WHERE task_id = ? AND state = 'ERROR'")
      .all(taskId) as Array<{ item_id: string; probe_json: string }>;
    for (const item of errors) {
      const nextState = durationFromProbe(item.probe_json) === null ? 'NEW' : 'PROBED';
      db.raw
        .prepare('UPDATE items SET state = ?, error_code = NULL, updated_at = ? WHERE item_id = ?')
        .run(nextState, nowIso(now), item.item_id);
      const failed = db.raw
        .prepare(
          `SELECT frame_id, path FROM frames
           WHERE item_id = ? AND state = 'FAILED' AND (error LIKE '取帧失败%' OR error LIKE '灰度解码失败%' OR error IS NULL)`,
        )
        .all(item.item_id) as Array<{ frame_id: string; path: string | null }>;
      for (const frame of failed) {
        if (typeof frame.path === 'string') removeOwnedFrame(dataDir, frame.path);
        db.raw.prepare('DELETE FROM frames WHERE frame_id = ?').run(frame.frame_id);
      }
    }
    db.raw.prepare("UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE task_id = ?").run(nowIso(now), taskId);
    return { ok: true, message: '已继续', status: 'RUNNING' };
  }
  if (action === 'cancel') {
    if (task.status !== 'RUNNING' && task.status !== 'PAUSED') return { ok: false, message: '状态不允许' };
    db.raw.prepare("UPDATE tasks SET status = 'CANCELLED', updated_at = ? WHERE task_id = ?").run(nowIso(now), taskId);
    return { ok: true, message: '已取消', status: 'CANCELLED' };
  }
  return { ok: false, message: 'action 必须是 pause、resume 或 cancel' };
}
