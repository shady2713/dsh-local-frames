import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import type { MediaClient } from '../src/media.js';
import { Pipeline } from '../src/pipeline.js';
import { SettingsStore } from '../src/settings.js';
import { buildStatus } from '../src/status.js';
import { createTools, type ToolDefinition } from '../src/tool.js';
import type { ToolResult } from '../src/types.js';
import { EnvironmentChecker } from '../src/versions.js';
import type { VisionClient } from '../src/vision.js';
import { fakeExec, healthySubprocess, makeTempDir, writeFixtureFile } from './helpers.js';

interface Harness {
  dataDir: string;
  db: LocalFramesDatabase;
  settings: SettingsStore;
  pipeline: Pipeline;
  tools: ToolDefinition[];
  tool(name: string): ToolDefinition;
}

const idleMedia: MediaClient = {
  async probeDuration() {
    return { ok: false, error: '测试探针' };
  },
  async extractFrame() {
    return { ok: false, error: '测试取帧', timedOut: false };
  },
  async decodeGray() {
    return { ok: false, error: '测试灰度' };
  },
  async shrinkJpeg() {
    return { ok: false, error: '测试缩小' };
  },
};

const idleVision: VisionClient = {
  available: () => false,
  async listImageModels() {
    return [];
  },
  async judge() {
    return { ok: false, kind: 'unavailable', message: '测试模型' };
  },
};

const openDatabases: LocalFramesDatabase[] = [];

function harness(): Harness {
  const dataDir = makeTempDir('lf-tools-');
  const db = openDatabase(dataDir);
  openDatabases.push(db);
  const settings = new SettingsStore(db);
  const environment = new EnvironmentChecker({
    subprocess: healthySubprocess(),
    dataDir,
    nodeVersion: '24.22.1',
    dshVersion: '0.2.1-rc.5',
    freeGb: () => 100,
  });
  const pipeline = new Pipeline({
    db,
    settings,
    dataDir,
    media: idleMedia,
    vision: idleVision,
    sleep: async () => undefined,
    log: () => undefined,
  });
  const tools = createTools({
    db,
    settings,
    buildStatus: (fresh) =>
      buildStatus({ db, settings, environment, dataDir, freshEnvironment: fresh, pluginVersion: '0.1.0' }),
    log: () => undefined,
    dataDir,
    pipeline,
    environment,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    dataDir,
    db,
    settings,
    pipeline,
    tools,
    tool(name: string): ToolDefinition {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      return tool;
    },
  };
}

function closeAll(): void {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
}

function resultOf(value: unknown): ToolResult {
  return value as ToolResult;
}

describe('agent tool registration', () => {
  it('registers exactly the six lf_ tools with the shared result schema', () => {
    const h = harness();
    try {
      expect(h.tools.map((tool) => tool.name)).toEqual([
        'lf_status',
        'lf_target_add',
        'lf_collect_start',
        'lf_video_add',
        'lf_collect_control',
        'lf_export',
      ]);
      for (const tool of h.tools) {
        expect(tool.parameters.type).toBe('object');
        expect(tool.output.schema.required).toEqual(['status', 'message', 'data']);
        expect(tool.output.schema.additionalProperties).toBe(false);
        expect(typeof tool.description).toBe('string');
      }
    } finally {
      closeAll();
    }
  });

  it('lf_status returns the environment, settings without secrets, and a task funnel', async () => {
    const h = harness();
    try {
      const result = resultOf(
        await h.tool('lf_status').execute({}, fakeExec()),
      );
      expect(result.status).toBe('OK');
      const data = result.data as {
        environment?: { ok?: boolean; checks?: unknown[] };
        settings?: Record<string, unknown>;
        funnel?: Record<string, number>;
      };
      expect(data.environment?.ok).toBe(true);
      expect(data.environment?.checks?.length).toBe(7);
      expect(data.settings?.frameIntervalSeconds).toBe(2);
      expect(JSON.stringify(data)).not.toMatch(/(apiKey|cookie|authorization|secret)/i);
      expect(data.funnel).toEqual({
        imported: 0,
        probed: 0,
        frames: 0,
        duplicatesSkipped: 0,
        judged: 0,
        exportable: 0,
        errors: 0,
      });
    } finally {
      closeAll();
    }
  });

  it('lf_video_add rejects a path while the allowlist is empty', async () => {
    const h = harness();
    try {
      const file = writeFixtureFile(join(makeTempDir('lf-root-'), 'clip.mp4'));
      const result = resultOf(await h.tool('lf_video_add').execute({ path: file }, fakeExec()));
      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('白名单');
      expect(result.data.code).toBe('NOT_ALLOWED');
    } finally {
      closeAll();
    }
  });

  it('lf_video_add rejects a relative path and a bad extension', async () => {
    const h = harness();
    try {
      const root = makeTempDir('lf-root-');
      h.settings.update({ allowRoots: [root] });
      const relative = resultOf(await h.tool('lf_video_add').execute({ path: 'clip.mp4' }, fakeExec()));
      expect(relative.status).toBe('ERROR');
      expect(relative.data.code).toBe('INVALID_PATH');

      const notes = writeFixtureFile(join(root, 'notes.txt'));
      const badExtension = resultOf(await h.tool('lf_video_add').execute({ path: notes }, fakeExec()));
      expect(badExtension.status).toBe('ERROR');
      expect(badExtension.data.code).toBe('BAD_EXTENSION');
    } finally {
      closeAll();
    }
  });

  it('lf_video_add validates a file, then refuses without an active task', async () => {
    const h = harness();
    try {
      const root = makeTempDir('lf-root-');
      h.settings.update({ allowRoots: [root] });
      const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
      const result = resultOf(await h.tool('lf_video_add').execute({ path: file }, fakeExec()));
      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('lf_collect_start');
    } finally {
      closeAll();
    }
  });

  it('lf_video_add stores a file without changing its bytes, and reports a repeat as already present', async () => {
    const h = harness();
    try {
      const root = makeTempDir('lf-root-');
      h.settings.update({ allowRoots: [root] });
      const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
      const before = createHash('sha256').update(readFileSync(file)).digest('hex');
      const now = new Date().toISOString();
      h.db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-1', '{}', '{}', 'RUNNING', now, now);
      const added = resultOf(await h.tool('lf_video_add').execute({ path: file }, fakeExec()));
      expect(added.status).toBe('OK');
      expect(added.data.task_id).toBe('task-1');
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
      const again = resultOf(await h.tool('lf_video_add').execute({ path: file }, fakeExec()));
      expect(again.status).toBe('ERROR');
      expect(again.message).toContain('已存在');
      const count = h.db.raw.prepare('SELECT COUNT(*) AS count FROM items').get() as { count?: number };
      expect(count.count).toBe(1);
      await h.pipeline.whenIdle();
    } finally {
      closeAll();
    }
  });

  it('lf_video_add scans a directory in path order and skips hidden directories', async () => {
    const h = harness();
    try {
      const root = makeTempDir('lf-root-');
      h.settings.update({ allowRoots: [root] });
      writeFixtureFile(join(root, 'b.mp4'), 'b');
      writeFixtureFile(join(root, 'a.mp4'), 'a');
      writeFixtureFile(join(root, '.hidden', 'c.mp4'), 'c');
      const outside = makeTempDir('lf-linked-');
      writeFixtureFile(join(outside, 'escape.mp4'), 'escape');
      mkdirSync(join(root, 'linked'));
      symlinkSync(outside, join(root, 'linked', 'out'));
      const now = new Date().toISOString();
      h.db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-1', '{}', '{}', 'RUNNING', now, now);
      const result = resultOf(await h.tool('lf_video_add').execute({ path: root }, fakeExec()));
      expect(result.status).toBe('OK');
      const rows = h.db.raw.prepare('SELECT title FROM items ORDER BY created_at ASC, rowid ASC').all() as Array<{ title: string }>;
      expect(rows.map((row) => row.title)).toEqual(['a.mp4', 'b.mp4']);
      await h.pipeline.whenIdle();
    } finally {
      closeAll();
    }
  });

  it('covers success, invalid input, illegal state, and repeated calls for the mutating tools', async () => {
    const h = harness();
    try {
      const missing = resultOf(await h.tool('lf_target_add').execute({}, fakeExec()));
      expect(missing.status).toBe('ERROR');
      const created = resultOf(
        await h.tool('lf_target_add').execute({ name: 'object-a', aliases: { en: ['thing'] }, definition: '一个用于测试的对象。' }, fakeExec()),
      );
      expect(created.status).toBe('OK');
      const targetId = created.data.target_id;
      expect(typeof targetId).toBe('string');
      const duplicate = resultOf(
        await h.tool('lf_target_add').execute({ name: 'object-a', aliases: {}, definition: '重复。' }, fakeExec()),
      );
      expect(duplicate.status).toBe('ERROR');
      expect(duplicate.message).toContain('同名');

      const noPaths = resultOf(await h.tool('lf_collect_start').execute({}, fakeExec()));
      expect(noPaths.status).toBe('ERROR');
      expect(String(noPaths.message)).toContain('未选择模型');

      const root = makeTempDir('lf-root-');
      const file = writeFixtureFile(join(root, 'clip.mp4'), 'clip');
      h.settings.update({
        allowRoots: [root],
        model: { provider: 'example', model: 'vision' },
      });
      const started = resultOf(await h.tool('lf_collect_start').execute({ paths: [file] }, fakeExec()));
      expect(started.status).toBe('OK');
      expect(typeof started.data.task_id).toBe('string');
      await h.pipeline.whenIdle();
      h.pipeline.stop();

      const now = new Date().toISOString();
      h.db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-control', '{}', '{}', 'RUNNING', now, now);
      const again = resultOf(await h.tool('lf_collect_start').execute({ paths: [file] }, fakeExec()));
      expect(again.status).toBe('ERROR');
      expect(again.message).toContain('已有进行中或暂停的任务');
      const paused = resultOf(await h.tool('lf_collect_control').execute({ taskId: 'task-control', action: 'pause' }, fakeExec()));
      expect(paused.status).toBe('OK');
      const pauseAgain = resultOf(
        await h.tool('lf_collect_control').execute({ taskId: 'task-control', action: 'pause' }, fakeExec()),
      );
      expect(pauseAgain.status).toBe('ERROR');
      expect(pauseAgain.message).toContain('状态不允许');
      const resumed = resultOf(await h.tool('lf_collect_control').execute({ taskId: 'task-control', action: 'resume' }, fakeExec()));
      expect(resumed.status).toBe('OK');
      const cancelled = resultOf(
        await h.tool('lf_collect_control').execute({ taskId: 'task-control', action: 'cancel' }, fakeExec()),
      );
      expect(cancelled.status).toBe('OK');
      const cancelAgain = resultOf(
        await h.tool('lf_collect_control').execute({ taskId: 'task-control', action: 'cancel' }, fakeExec()),
      );
      expect(cancelAgain.status).toBe('ERROR');

      const exportDir = makeTempDir('lf-tool-export-');
      h.settings.update({ exportDir });
      const exported = resultOf(await h.tool('lf_export').execute({}, fakeExec()));
      expect(exported.status).toBe('OK');
      expect(exported.data.images).toBe(0);
      expect(dirname(String(exported.data.directory))).toBe(exportDir);
      const missingExport = resultOf(await h.tool('lf_export').execute({ taskId: 'missing-task' }, fakeExec()));
      expect(missingExport.status).toBe('ERROR');
      await h.pipeline.whenIdle();
    } finally {
      closeAll();
    }
  });

  it('renders a bounded JSON projection for the agent', async () => {
    const h = harness();
    try {
      const rendered = h.tool('lf_status').output.render(
        {},
        { status: 'OK', message: 'm', data: { blob: 'x'.repeat(10_000) } },
      );
      expect(rendered).toHaveLength(1);
      expect(rendered[0]?.text.length).toBeLessThanOrEqual(6_100);
      expect(rendered[0]?.text).toContain('...(truncated)');
    } finally {
      closeAll();
    }
  });
});
