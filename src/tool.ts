import { directorySizeBytes, freeDiskGb, DEFAULT_MIN_FREE_DISK_GB } from './disk.js';
import type { LocalFramesDatabase } from './db.js';
import { acceptedCount, describeIngest, ingestPaths } from './ingest.js';
import { InputError, validateVideoPath } from './input.js';
import { newId, nowIso } from './ids.js';
import { exportTask } from './export.js';
import { controlTask } from './pipeline.js';
import type { Pipeline } from './pipeline.js';
import { emptyProgress } from './progress.js';
import type { SettingsStore } from './settings.js';
import type { Settings, StatusSnapshot, TargetAliases, ToolResult } from './types.js';
import type { EnvironmentChecker } from './versions.js';

const MAX_RENDERED_JSON = 6_000;

export interface ToolExecutionLike {
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>;
  };
  isConcurrencySafe?: () => boolean;
  execute: (args: unknown, exec: ToolExecutionLike) => Promise<unknown>;
}

export interface ToolDeps {
  db: LocalFramesDatabase;
  settings: SettingsStore;
  buildStatus: (freshEnvironment: boolean) => Promise<StatusSnapshot>;
  log: (message: string) => void;
  dataDir: string;
  pipeline: Pipeline;
  environment: EnvironmentChecker;
}

function outputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['OK', 'ERROR'] },
      message: { type: 'string' },
      data: { type: 'object', additionalProperties: true },
    },
    required: ['status', 'message', 'data'],
    additionalProperties: false,
  };
}

/** The agent sees only rendered text, so include a bounded JSON projection of data. */
function renderText(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const record = value as { status?: unknown; message?: unknown; data?: unknown };
  const headline = typeof record.message === 'string' ? record.message : 'local-frames';
  if (record.data === undefined || record.data === null) return [{ type: 'text', text: headline }];
  let data: string;
  try {
    data = JSON.stringify(record.data);
  } catch {
    return [{ type: 'text', text: headline }];
  }
  if (data.length > MAX_RENDERED_JSON) data = `${data.slice(0, MAX_RENDERED_JSON)}...(truncated)`;
  return [{ type: 'text', text: `${headline}\n${data}` }];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fail(message: string, data: Record<string, unknown> = {}): ToolResult {
  return { status: 'ERROR', message, data };
}

function ok(message: string, data: Record<string, unknown> = {}): ToolResult {
  return { status: 'OK', message, data };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unknownKeys(input: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return `未知参数 ${key}`;
  }
  return null;
}

function activeTask(db: LocalFramesDatabase): { task_id: string; status: string } | null {
  const row = db.raw
    .prepare(
      "SELECT task_id, status FROM tasks WHERE status IN ('RUNNING', 'PAUSED') ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { task_id?: string; status?: string } | undefined;
  if (typeof row?.task_id !== 'string' || typeof row.status !== 'string') return null;
  return { task_id: row.task_id, status: row.status };
}

function parseAliases(value: unknown): TargetAliases | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'aliases 必须是按语言分组的对象';
  const aliases: TargetAliases = {};
  const entries = Object.entries(value);
  if (entries.length > 8) return 'aliases 最多 8 种语言';
  for (const [language, list] of entries) {
    if (language.trim().length === 0 || language.length > 32) return 'aliases 的语言代码无效';
    if (!Array.isArray(list) || list.length > 8) return '每种语言最多 8 个别名';
    const names: string[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 80) return '别名必须是非空字符串';
      names.push(entry.trim());
    }
    aliases[language.trim()] = names;
  }
  return aliases;
}

function stringList(value: unknown, field: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} 必须是字符串数组`;
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) return `${field} 必须是非空字符串数组`;
    items.push(entry.trim());
  }
  return items;
}

function blockingEnvironment(report: { checks: Array<{ blocking: boolean; status: string; label: string; detail: string | null }> }): string[] {
  return report.checks
    .filter((check) => check.blocking && check.status !== 'OK')
    .map((check) => `${check.label}：${check.detail ?? check.status}`);
}

function capacityProblems(dataDir: string, settings: Settings): string[] {
  const problems: string[] = [];
  const free = freeDiskGb(dataDir);
  if (free !== null && free < DEFAULT_MIN_FREE_DISK_GB) {
    problems.push(`磁盘剩余 ${free.toFixed(1)} GB，低于 ${DEFAULT_MIN_FREE_DISK_GB} GB`);
  }
  const used = directorySizeBytes(dataDir);
  if (used > settings.dataDirLimitGb * 1e9) problems.push('数据目录超过设置上限');
  return problems;
}

export function createStatusTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_status',
    description:
      'Read local-frames status: settings without secrets, object list, task progress, file funnel including duplicate-frame skips, data-directory usage, and the environment check (Node/npm/ffmpeg/ffprobe/DSH/Git). Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => true,
    async execute(): Promise<unknown> {
      try {
        const status = await deps.buildStatus(true);
        const okayChecks = status.environment.checks.filter((check) => check.status === 'OK').length;
        const parts = [
          `local-frames ${status.plugin.version}`,
          `环境 ${status.environment.ok ? 'OK' : '有问题'}（${okayChecks}/${status.environment.checks.length} 项正常）`,
          `对象 ${status.targets.length}`,
          status.task === null ? '任务 无' : `任务 ${status.task.status}`,
          `数据目录 ${status.dataDir.path}（上限 ${status.dataDir.limitGb} GB）`,
        ];
        if (status.environment.missing.length > 0) {
          parts.push(`需处理：${status.environment.missing.join(', ')}`);
        }
        return ok(parts.join('；'), status as unknown as Record<string, unknown>);
      } catch (error) {
        return fail(`lf_status 失败：${errorText(error)}`);
      }
    },
  };
}

export function createTargetAddTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_target_add',
    description:
      'Add one object the vision model must judge on every frame: a unique active name, per-language aliases, and a one-sentence definition.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique object name among unarchived objects' },
        aliases: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
          description: 'Aliases keyed by language code, each value an array of strings',
        },
        definition: { type: 'string', description: 'One-sentence definition of what counts as this object' },
      },
      required: ['name', 'aliases', 'definition'],
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const input = asRecord(args);
      const unknown = unknownKeys(input, ['name', 'aliases', 'definition']);
      if (unknown !== null) return fail(unknown);
      if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.trim().length > 80) {
        return fail('name 必须是 1 到 80 个字符');
      }
      if (typeof input.definition !== 'string' || input.definition.trim().length === 0 || input.definition.trim().length > 400) {
        return fail('definition 必须是一句话');
      }
      const aliases = parseAliases(input.aliases);
      if (typeof aliases === 'string') return fail(aliases);
      const name = input.name.trim();
      const duplicate = deps.db.raw
        .prepare('SELECT target_id FROM targets WHERE name = ? AND archived = 0')
        .get(name) as { target_id?: string } | undefined;
      if (typeof duplicate?.target_id === 'string') return fail('同名未归档对象已存在', { target_id: duplicate.target_id });
      const targetId = newId();
      const now = nowIso();
      deps.db.raw
        .prepare(
          'INSERT INTO targets (target_id, name, aliases_json, definition, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        )
        .run(targetId, name, JSON.stringify(aliases), input.definition.trim(), now, now);
      return ok(`已添加对象 ${name}`, { target_id: targetId, name });
    },
  };
}

export function createCollectStartTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_collect_start',
    description:
      'Create and start the single collection task: selected objects, optional first batch of local video paths, frame interval, disk cap, and model-call budget. Videos already framed and labelled by an earlier task are skipped by default; pass force=true to rerun them. Refuses when a running or paused task exists, the model or objects are missing, the allowlist is empty, or disk is insufficient.',
    parameters: {
      type: 'object',
      properties: {
        targetIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Object ids to judge; omit to use every unarchived object',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional first batch of absolute local video file or directory paths',
        },
        force: {
          type: 'boolean',
          description: 'Explicitly rerun videos already framed and labelled by an earlier task (default false)',
        },
      },
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const input = asRecord(args);
      const unknown = unknownKeys(input, ['targetIds', 'paths', 'force']);
      if (unknown !== null) return fail(unknown);
      if (input.force !== undefined && typeof input.force !== 'boolean') return fail('force 必须是布尔值');
      const force = input.force === true;
      const targetIds = stringList(input.targetIds, 'targetIds');
      if (typeof targetIds === 'string') return fail(targetIds);
      const paths = stringList(input.paths, 'paths');
      if (typeof paths === 'string') return fail(paths);
      const settings = deps.settings.load();
      const missing: string[] = [];
      if (activeTask(deps.db) !== null) missing.push('已有进行中或暂停的任务');
      if (settings.model === null) missing.push('未选择模型');
      if (settings.allowRoots.length === 0) missing.push('允许读取的视频根目录白名单为空');
      const selected = selectTargets(deps.db, targetIds.length === 0 ? null : targetIds);
      if (typeof selected === 'string') missing.push(selected);
      else if (selected.length === 0) missing.push('没有可用的对象定义');
      missing.push(...capacityProblems(deps.dataDir, settings));
      let environment;
      try {
        environment = await deps.environment.check(true);
      } catch (error) {
        return fail(`lf_collect_start 失败：${errorText(error)}`);
      }
      missing.push(...blockingEnvironment(environment));
      if (paths.length === 0) missing.push('没有视频路径');
      if (missing.length > 0 || typeof selected === 'string') {
        return fail(missing.join('；'), { missing });
      }
      const taskId = newId();
      const now = nowIso();
      const spec = {
        targetIds: selected.map((target) => target.target_id),
        frameIntervalSeconds: settings.frameIntervalSeconds,
        budgetPerTask: settings.budgetPerTask,
        model: settings.model,
      };
      deps.db.raw
        .prepare(
          'INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(taskId, JSON.stringify(spec), JSON.stringify(emptyProgress()), 'RUNNING', now, now);
      let report;
      try {
        report = await ingestPaths(
          deps.db,
          taskId,
          deps.dataDir,
          settings.allowRoots,
          paths.map((path) => ({ path, recursive: true })),
          { force },
        );
      } catch (error) {
        deps.db.raw.prepare('DELETE FROM items WHERE task_id = ?').run(taskId);
        deps.db.raw.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
        return fail(`lf_collect_start 失败：${errorText(error)}`);
      }
      if (acceptedCount(report) === 0) {
        deps.db.raw.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
        const detail = report.rejected[0]?.message ?? report.existing[0]?.localPath ?? '没有可用的视频';
        return fail(report.existing.length > 0 ? `已存在：${detail}` : detail, {
          rejected: report.rejected,
          existing: report.existing.map((item) => item.itemId),
        });
      }
      deps.pipeline.kick();
      return ok(`已开始任务。${describeIngest(report)}`, {
        task_id: taskId,
        target_ids: spec.targetIds,
        item_ids: [...report.added, ...report.skipped, ...report.rerun].map((item) => item.itemId),
        added: report.added,
        skipped: report.skipped,
        rerun: report.rerun,
        existing: report.existing,
        rejected: report.rejected,
      });
    },
  };
}

export function createVideoAddTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_video_add',
    description:
      'Add one absolute local video file path or directory path to the running or paused task. The file is only read; it is never moved, renamed, or modified. Directories are scanned recursively by default. Videos already framed and labelled by an earlier task are skipped by default; pass force=true to rerun them.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute local video file or directory path' },
        recursive: { type: 'boolean', description: 'Recursively scan a directory (default true)' },
        force: {
          type: 'boolean',
          description: 'Explicitly rerun this file or directory even if a previous task already processed it (default false)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const input = asRecord(args);
      const unknown = unknownKeys(input, ['path', 'recursive', 'force']);
      if (unknown !== null) return fail(unknown);
      if (typeof input.path !== 'string') return fail('path 必须是字符串');
      if (input.recursive !== undefined && typeof input.recursive !== 'boolean') return fail('recursive 必须是布尔值');
      if (input.force !== undefined && typeof input.force !== 'boolean') return fail('force 必须是布尔值');
      const recursive = input.recursive !== false;
      const force = input.force === true;
      const task = activeTask(deps.db);
      if (task === null) {
        try {
          await validateVideoPath(input.path, { allowRoots: deps.settings.load().allowRoots });
        } catch (error) {
          if (error instanceof InputError) return fail(error.message, { code: error.code });
          return fail(`lf_video_add 失败：${errorText(error)}`);
        }
        return fail('没有进行中或暂停的任务；请先调用 lf_collect_start 创建任务');
      }
      if (task.status !== 'RUNNING' && task.status !== 'PAUSED') {
        return fail('任务已结束，不能再添加视频', { task_id: task.task_id });
      }
      try {
        const report = await ingestPaths(
          deps.db,
          task.task_id,
          deps.dataDir,
          deps.settings.load().allowRoots,
          [{ path: input.path, recursive }],
          { force },
        );
        if (acceptedCount(report) === 0) {
          if (report.existing.length > 0 && report.rejected.length === 0) {
            return fail('已存在', {
              task_id: task.task_id,
              item_id: report.existing[0]?.itemId ?? null,
              path: report.existing[0]?.localPath ?? input.path,
            });
          }
          return fail(report.rejected[0]?.message ?? '没有可用的视频', {
            code: report.rejected[0]?.code ?? 'EMPTY',
            rejected: report.rejected,
          });
        }
        deps.pipeline.kick();
        return ok(describeIngest(report), {
          task_id: task.task_id,
          item_ids: [...report.added, ...report.skipped, ...report.rerun].map((item) => item.itemId),
          added: report.added,
          skipped: report.skipped,
          rerun: report.rerun,
          existing: report.existing,
          rejected: report.rejected,
        });
      } catch (error) {
        if (error instanceof InputError) return fail(error.message, { code: error.code });
        deps.log(`lf_video_add 失败：${errorText(error)}`);
        return fail(`lf_video_add 失败：${errorText(error)}`);
      }
    },
  };
}

export function createCollectControlTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_collect_control',
    description:
      'Pause, resume (including retrying ERROR files), or cancel a collection task. Resume and cancel require the task id returned by lf_collect_start.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id' },
        action: { type: 'string', enum: ['pause', 'resume', 'cancel'], description: 'Control action' },
      },
      required: ['taskId', 'action'],
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const input = asRecord(args);
      const unknown = unknownKeys(input, ['taskId', 'action']);
      if (unknown !== null) return fail(unknown);
      if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) return fail('taskId 必须是字符串');
      if (input.action !== 'pause' && input.action !== 'resume' && input.action !== 'cancel') {
        return fail('action 必须是 pause、resume 或 cancel');
      }
      const result = controlTask(deps.db, deps.dataDir, input.taskId.trim(), input.action);
      if (!result.ok) return fail(result.message, { task_id: input.taskId });
      if (input.action === 'resume') deps.pipeline.kick();
      return ok(result.message, { task_id: input.taskId, status: result.status ?? input.action });
    },
  };
}

export function createExportTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_export',
    description:
      'Export the qualified frames of a task into a new timestamped directory under the configured export directory (default dataDir/exports), with images/, labels.csv, sources.csv and README.txt. Omit taskId for the current or most recently finished task.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id; omit for the current or latest finished task' },
      },
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const input = asRecord(args);
      const unknown = unknownKeys(input, ['taskId']);
      if (unknown !== null) return fail(unknown);
      const requested = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const taskId = requested.length > 0 ? requested : defaultExportTask(deps.db);
      if (taskId === null) return fail('没有可导出的任务');
      const existing = deps.db.raw.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(taskId) as
        | { task_id?: string }
        | undefined;
      if (typeof existing?.task_id !== 'string') return fail('任务不存在', { task_id: taskId });
      try {
        const exported = exportTask(deps.db, deps.dataDir, taskId, new Date(), deps.settings.load().exportDir);
        return ok(`已导出 ${exported.images} 张图片`, {
          task_id: taskId,
          directory: exported.directory,
          images: exported.images,
          train: exported.train,
          val: exported.val,
          duplicatesSkipped: exported.duplicatesSkipped,
        });
      } catch (error) {
        return fail(`导出失败：${errorText(error)}`, { task_id: taskId });
      }
    },
  };
}

function selectTargets(
  db: LocalFramesDatabase,
  ids: string[] | null,
): Array<{ target_id: string }> | string {
  if (ids === null) {
    return db.raw
      .prepare("SELECT target_id FROM targets WHERE archived = 0 AND length(trim(definition)) > 0 ORDER BY created_at ASC, rowid ASC")
      .all() as Array<{ target_id: string }>;
  }
  const selected: Array<{ target_id: string }> = [];
  for (const id of ids) {
    const row = db.raw
      .prepare('SELECT target_id, archived, definition FROM targets WHERE target_id = ?')
      .get(id) as { target_id?: string; archived?: number; definition?: string } | undefined;
    if (typeof row?.target_id !== 'string') return `对象不存在：${id}`;
    if (row.archived !== 0) return `对象已归档：${id}`;
    if (typeof row.definition !== 'string' || row.definition.trim().length === 0) return `对象缺少定义：${id}`;
    selected.push({ target_id: row.target_id });
  }
  return selected;
}

function defaultExportTask(db: LocalFramesDatabase): string | null {
  const active = activeTask(db);
  if (active !== null) return active.task_id;
  const done = db.raw
    .prepare("SELECT task_id FROM tasks WHERE status = 'DONE' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
    .get() as { task_id?: string } | undefined;
  return typeof done?.task_id === 'string' ? done.task_id : null;
}

/** All six agent tools, in the order agents should discover them. */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  return [
    createStatusTool(deps),
    createTargetAddTool(deps),
    createCollectStartTool(deps),
    createVideoAddTool(deps),
    createCollectControlTool(deps),
    createExportTool(deps),
  ];
}
