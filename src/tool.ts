import type { LocalFramesDatabase } from './db.js';
import { InputError, validateVideoPath } from './input.js';
import type { SettingsStore } from './settings.js';
import type { StatusSnapshot, ToolResult } from './types.js';

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

const NOT_IMPLEMENTED_STAGE_1 = '阶段 1 骨架尚未实现该操作；等阶段 2/3 实现后再调用。';

/** Active task means RUNNING or PAUSED, per §13 `lf_video_add`. */
function activeTaskId(db: LocalFramesDatabase): string | null {
  const row = db.raw
    .prepare(
      "SELECT task_id FROM tasks WHERE status IN ('RUNNING', 'PAUSED') ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { task_id?: string } | undefined;
  return typeof row?.task_id === 'string' ? row.task_id : null;
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

export function createTargetAddTool(_deps: ToolDeps): ToolDefinition {
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
    async execute(): Promise<unknown> {
      return fail(NOT_IMPLEMENTED_STAGE_1);
    },
  };
}

export function createCollectStartTool(_deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_collect_start',
    description:
      'Create and start the single collection task: selected objects, optional first batch of local video paths, frame interval, disk cap, and model-call budget. Refuses when a running or paused task exists, the model or objects are missing, the allowlist is empty, or disk is insufficient.',
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
      },
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(): Promise<unknown> {
      return fail(NOT_IMPLEMENTED_STAGE_1);
    },
  };
}

export function createVideoAddTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_video_add',
    description:
      'Add one absolute local video file path or directory path to the running or paused task. The file is only read; it is never moved, renamed, or modified. Directories are scanned recursively by default.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute local video file or directory path' },
        recursive: { type: 'boolean', description: 'Recursively scan a directory (default true)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const input = asRecord(args);
      if (input.recursive !== undefined && typeof input.recursive !== 'boolean') {
        return fail('recursive 必须是布尔值');
      }
      const recursive = input.recursive !== false;
      try {
        const validated = await validateVideoPath(input.path, {
          allowRoots: deps.settings.load().allowRoots,
        });
        if (validated.kind === 'directory') {
          return fail(`目录扫描尚未实现（阶段 2）：${validated.localPath}`, {
            path: validated.localPath,
            kind: 'directory',
            recursive,
          });
        }
        const taskId = activeTaskId(deps.db);
        if (taskId === null) {
          return fail('没有进行中或暂停的任务；请先调用 lf_collect_start 创建任务', {
            path: validated.localPath,
            kind: 'file',
          });
        }
        return fail(`${NOT_IMPLEMENTED_STAGE_1}（视频入库：${validated.localPath}）`, {
          path: validated.localPath,
          kind: 'file',
          bytes: validated.bytes,
          task_id: taskId,
        });
      } catch (error) {
        if (error instanceof InputError) {
          return fail(error.message, { code: error.code });
        }
        deps.log(`lf_video_add failed: ${errorText(error)}`);
        return fail(`lf_video_add 失败：${errorText(error)}`);
      }
    },
  };
}

export function createCollectControlTool(_deps: ToolDeps): ToolDefinition {
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
    async execute(): Promise<unknown> {
      return fail(NOT_IMPLEMENTED_STAGE_1);
    },
  };
}

export function createExportTool(_deps: ToolDeps): ToolDefinition {
  return {
    name: 'lf_export',
    description:
      'Export the qualified frames of a task into a new exports/<timestamp>/ directory with images/, labels.csv, sources.csv and README.txt. Omit taskId for the current or most recently finished task.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id; omit for the current or latest finished task' },
      },
      additionalProperties: false,
    },
    output: { schema: outputSchema(), render: renderText },
    isConcurrencySafe: () => false,
    async execute(): Promise<unknown> {
      return fail(NOT_IMPLEMENTED_STAGE_1);
    },
  };
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
