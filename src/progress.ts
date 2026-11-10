import type { LocalFramesDatabase } from './db.js';
import { nowIso } from './ids.js';

export interface CsvProblem {
  path: string;
  message: string;
}

export interface TaskProgress {
  pauseReason: string | null;
  pauseCode: string | null;
  csvErrors: CsvProblem[];
  retryAt: string | null;
  gap: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  consecutiveCallFailures: number;
  consecutiveOutputFailures: number;
}

export function emptyProgress(): TaskProgress {
  return {
    pauseReason: null,
    pauseCode: null,
    csvErrors: [],
    retryAt: null,
    gap: null,
    report: null,
    consecutiveCallFailures: 0,
    consecutiveOutputFailures: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCsvErrors(value: unknown): CsvProblem[] {
  if (!Array.isArray(value)) return [];
  const problems: CsvProblem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.path !== 'string' || typeof entry.message !== 'string') continue;
    problems.push({ path: entry.path, message: entry.message });
  }
  return problems;
}

export function readProgress(text: string | null | undefined): TaskProgress {
  const base = emptyProgress();
  if (typeof text !== 'string' || text.length === 0) return base;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return base;
    return {
      pauseReason: typeof parsed.pauseReason === 'string' ? parsed.pauseReason : null,
      pauseCode: typeof parsed.pauseCode === 'string' ? parsed.pauseCode : null,
      csvErrors: readCsvErrors(parsed.csvErrors),
      retryAt: typeof parsed.retryAt === 'string' ? parsed.retryAt : null,
      gap: isRecord(parsed.gap) ? parsed.gap : null,
      report: isRecord(parsed.report) ? parsed.report : null,
      consecutiveCallFailures:
        typeof parsed.consecutiveCallFailures === 'number' && parsed.consecutiveCallFailures >= 0
          ? parsed.consecutiveCallFailures
          : 0,
      consecutiveOutputFailures:
        typeof parsed.consecutiveOutputFailures === 'number' && parsed.consecutiveOutputFailures >= 0
          ? parsed.consecutiveOutputFailures
          : 0,
    };
  } catch {
    return base;
  }
}

export function writeProgress(db: LocalFramesDatabase, taskId: string, progress: TaskProgress, now: Date = new Date()): void {
  db.raw
    .prepare('UPDATE tasks SET progress_json = ?, updated_at = ? WHERE task_id = ?')
    .run(JSON.stringify(progress), nowIso(now), taskId);
}

export interface TaskSpec {
  targetIds: string[];
  frameIntervalSeconds: number;
  budgetPerTask: number;
  model: { provider: string; model: string } | null;
}

export function readSpec(text: string | null | undefined): TaskSpec {
  const fallback: TaskSpec = {
    targetIds: [],
    frameIntervalSeconds: 2,
    budgetPerTask: 3000,
    model: null,
  };
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return fallback;
    const targetIds = Array.isArray(parsed.targetIds)
      ? parsed.targetIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const interval =
      typeof parsed.frameIntervalSeconds === 'number' && Number.isInteger(parsed.frameIntervalSeconds)
        ? parsed.frameIntervalSeconds
        : 2;
    const budget =
      typeof parsed.budgetPerTask === 'number' && Number.isInteger(parsed.budgetPerTask) ? parsed.budgetPerTask : 3000;
    let model: TaskSpec['model'] = null;
    if (isRecord(parsed.model) && typeof parsed.model.provider === 'string' && typeof parsed.model.model === 'string') {
      model = { provider: parsed.model.provider, model: parsed.model.model };
    }
    return { targetIds, frameIntervalSeconds: interval, budgetPerTask: budget, model };
  } catch {
    return fallback;
  }
}

export const MODEL_RETRY_MS = 10 * 60 * 1000;
export const OUTPUT_FAIL_LIMIT = 5;
export const CALL_FAIL_LIMIT = 3;
