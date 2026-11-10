import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, type LocalFramesDatabase } from '../src/db.js';
import { SettingsStore } from '../src/settings.js';
import { buildStatus } from '../src/status.js';
import { createTools, type ToolDefinition } from '../src/tool.js';
import type { ToolResult } from '../src/types.js';
import { EnvironmentChecker } from '../src/versions.js';
import { fakeExec, healthySubprocess, makeTempDir, writeFixtureFile } from './helpers.js';

interface Harness {
  dataDir: string;
  db: LocalFramesDatabase;
  settings: SettingsStore;
  tools: ToolDefinition[];
  tool(name: string): ToolDefinition;
}

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
  const tools = createTools({
    db,
    settings,
    buildStatus: (fresh) =>
      buildStatus({ db, settings, environment, dataDir, freshEnvironment: fresh, pluginVersion: '0.1.0' }),
    log: () => undefined,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    dataDir,
    db,
    settings,
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
      expect(result.data.path).toBe(file);
      expect(result.data.kind).toBe('file');
    } finally {
      closeAll();
    }
  });

  it('lf_video_add reaches the stage-1 placeholder once a task exists', async () => {
    const h = harness();
    try {
      const root = makeTempDir('lf-root-');
      h.settings.update({ allowRoots: [root] });
      const file = writeFixtureFile(join(root, 'clip.mp4'), 'fixture bytes');
      const now = new Date().toISOString();
      h.db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-1', '{}', '{}', 'RUNNING', now, now);
      const result = resultOf(await h.tool('lf_video_add').execute({ path: file }, fakeExec()));
      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('阶段 1');
      expect(result.data.task_id).toBe('task-1');
    } finally {
      closeAll();
    }
  });

  it('lf_video_add reports directory input as a stage-2 scan placeholder', async () => {
    const h = harness();
    try {
      const root = makeTempDir('lf-root-');
      h.settings.update({ allowRoots: [root] });
      const result = resultOf(await h.tool('lf_video_add').execute({ path: root }, fakeExec()));
      expect(result.status).toBe('ERROR');
      expect(result.message).toContain('目录扫描');
      expect(result.data.kind).toBe('directory');
    } finally {
      closeAll();
    }
  });

  it('the not-yet-implemented tools fail honestly instead of returning fake success', async () => {
    const h = harness();
    try {
      for (const name of ['lf_target_add', 'lf_collect_start', 'lf_collect_control', 'lf_export']) {
        const result = resultOf(await h.tool(name).execute({}, fakeExec()));
        expect(result.status).toBe('ERROR');
        expect(result.message).toContain('阶段 1');
        expect(result.data).toEqual({});
      }
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
