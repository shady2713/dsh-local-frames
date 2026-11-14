import { readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { ExportDirectoryError, ExportSelectionError, exportTask } from '../src/export.js';
import type { Pipeline } from '../src/pipeline.js';
import { createRoutes } from '../src/routes.js';
import { SettingsStore } from '../src/settings.js';
import { createTools, type ToolDefinition } from '../src/tool.js';
import type { StatusSnapshot, ToolResult } from '../src/types.js';
import { EnvironmentChecker } from '../src/versions.js';
import { seedExportTask } from './export-helpers.js';
import { fakeExec, healthySubprocess, makeTempDir, mockRequest, mockResponse, writeFixtureFile } from './helpers.js';

const snapshot = async (): Promise<StatusSnapshot> => ({}) as StatusSnapshot;

function readLabels(directory: string): { header: string; rows: string[] } {
  const lines = readFileSync(join(directory, 'labels.csv'), 'utf8').trim().split('\n');
  return { header: lines[0] ?? '', rows: lines.slice(1) };
}

function readStats(directory: string): { match?: string; images?: number } {
  return JSON.parse(readFileSync(join(directory, 'stats.json'), 'utf8')) as { match?: string; images?: number };
}

function readReadme(directory: string): string {
  return readFileSync(join(directory, 'README.txt'), 'utf8');
}

interface Persisted {
  db: ReturnType<typeof openDatabase>;
  settings: SettingsStore;
  dataDir: string;
  routes: ReturnType<typeof createRoutes>;
  opened: string[];
}

function persistedRoutes(): Persisted {
  const dataDir = makeTempDir('lf-issue26-routes-');
  const db = openDatabase(dataDir);
  const settings = new SettingsStore(db);
  const opened: string[] = [];
  const routes = createRoutes({
    buildStatus: snapshot,
    log: () => undefined,
    db,
    settings,
    dataDir,
    pipeline: { kick: () => undefined } as unknown as Pipeline,
    openPath: async (directory) => {
      opened.push(directory);
    },
  });
  return { db, settings, dataDir, routes, opened };
}

async function postJson(routesToCall: ReturnType<typeof createRoutes>, url: string, body: unknown) {
  const { res, result } = mockResponse();
  await routesToCall(
    mockRequest({
      method: 'POST',
      url,
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    res,
  );
  return result;
}

interface ToolHarness {
  db: ReturnType<typeof openDatabase>;
  settings: SettingsStore;
  dataDir: string;
  tool: (name: string) => ToolDefinition;
}

function toolHarness(): ToolHarness {
  const dataDir = makeTempDir('lf-issue26-tools-');
  const db = openDatabase(dataDir);
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
    dataDir,
    pipeline: { kick: () => undefined } as unknown as Pipeline,
    environment,
    log: () => undefined,
    buildStatus: snapshot,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    db,
    settings,
    dataDir,
    tool(name: string): ToolDefinition {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      return tool;
    },
  };
}

function resultOf(value: unknown): ToolResult {
  return value as ToolResult;
}

describe('issue #26 match modes', () => {
  it('exports any-hit frames and only all-hit frames without changing the old default', () => {
    const dataDir = makeTempDir('lf-issue26-match-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const selected = [seeded.targetA, seeded.targetB];

      const anyExport = exportTask(db, dataDir, seeded.taskId, new Date(), null, { targetIds: selected });
      expect(anyExport.images).toBe(3);
      expect(anyExport.match).toBe('any');
      expect(readStats(anyExport.directory).match).toBe('any');
      expect(readReadme(anyExport.directory)).toContain('匹配方式：任一命中（或）');
      expect(readdirSync(join(anyExport.directory, 'images'))).toHaveLength(3);

      const allExport = exportTask(db, dataDir, seeded.taskId, new Date(), null, {
        targetIds: selected,
        match: 'all',
      });
      expect(allExport.images).toBe(1);
      expect(allExport.match).toBe('all');
      expect(readStats(allExport.directory).match).toBe('all');
      expect(readReadme(allExport.directory)).toContain('匹配方式：全部命中（且）');
      const images = readdirSync(join(allExport.directory, 'images'));
      expect(images).toHaveLength(1);
      expect(images[0]).toBe(`clip-${seeded.frames[0]!.frameId}.jpg`);
      const labels = readLabels(allExport.directory);
      expect(labels.header).toBe('file_name,split,family_id,object-a,object-b');
      expect(labels.rows).toHaveLength(1);
      expect(labels.rows[0]?.split(',')[0]).toBe(images[0]);
    } finally {
      db.close();
    }
  });

  it('keeps labels.csv to the selected object columns and leaves the default match at any', () => {
    const dataDir = makeTempDir('lf-issue26-columns-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const unselected = exportTask(db, dataDir, seeded.taskId);
      expect(unselected.images).toBe(3);
      expect(unselected.match).toBe('any');
      expect(readStats(unselected.directory).match).toBe('any');
      expect(readLabels(unselected.directory).header).toBe('file_name,split,family_id,object-a,object-b');

      const selected = exportTask(db, dataDir, seeded.taskId, new Date(), null, {
        targetIds: [seeded.targetB],
        match: 'all',
      });
      expect(selected.images).toBe(2);
      expect(readLabels(selected.directory).header).toBe('file_name,split,family_id,object-b');
    } finally {
      db.close();
    }
  });

  it('places one copy per selected object directory for all matches', () => {
    const dataDir = makeTempDir('lf-issue26-all-objects-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const exported = exportTask(db, dataDir, seeded.taskId, new Date(), null, {
        targetIds: [seeded.targetA, seeded.targetB],
        match: 'all',
        byObject: true,
      });
      expect(exported.images).toBe(1);
      expect(exported.imageCopies).toBe(2);
      const directories = readdirSync(join(exported.directory, 'images')).sort();
      expect(directories).toEqual(['object-a', 'object-b']);
      for (const directory of directories) {
        expect(readdirSync(join(exported.directory, 'images', directory))).toEqual([
          `clip-${seeded.frames[0]!.frameId}.jpg`,
        ]);
      }
      expect(readLabels(exported.directory).header).toBe('file_name,split,family_id,object-a,object-b');
    } finally {
      db.close();
    }
  });

  it('rejects all with no selected object through the exporter, route and tool', async () => {
    const h = persistedRoutes();
    try {
      const seeded = seedExportTask(h.db, h.dataDir);
      expect(() => exportTask(h.db, h.dataDir, seeded.taskId, new Date(), null, { match: 'all' })).toThrow(
        ExportSelectionError,
      );
      expect(() =>
        exportTask(h.db, h.dataDir, seeded.taskId, new Date(), null, { targetIds: [], match: 'all' }),
      ).toThrow('全部命中需要至少勾选一个对象');

      const routed = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        match: 'all',
      });
      expect(routed.status).toBe(400);
      expect(routed.json()).toMatchObject({ code: 'INVALID_TARGETS', message: '全部命中需要至少勾选一个对象' });
    } finally {
      h.db.close();
    }

    const t = toolHarness();
    try {
      const seeded = seedExportTask(t.db, t.dataDir);
      const failed = resultOf(await t.tool('lf_export').execute({ taskId: seeded.taskId, match: 'all' }, fakeExec()));
      expect(failed.status).toBe('ERROR');
      expect(failed.message).toBe('全部命中需要至少勾选一个对象');
    } finally {
      t.db.close();
    }
  });

  it('rejects an invalid match value through the exporter, route and tool', async () => {
    const dataDir = makeTempDir('lf-issue26-match-invalid-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      expect(() =>
        exportTask(db, dataDir, seeded.taskId, new Date(), null, { match: 'both' as never }),
      ).toThrow('match 必须是 any 或 all');
    } finally {
      db.close();
    }

    const h = persistedRoutes();
    try {
      const routed = await postJson(h.routes, '/api/local-frames/export', { match: 'both' });
      expect(routed.status).toBe(400);
      expect(routed.json()).toMatchObject({ code: 'INVALID_BODY', message: 'match 必须是 any 或 all' });
    } finally {
      h.db.close();
    }

    const t = toolHarness();
    try {
      const failed = resultOf(await t.tool('lf_export').execute({ match: 'both' }, fakeExec()));
      expect(failed.status).toBe('ERROR');
      expect(failed.message).toBe('match 必须是 any 或 all');
    } finally {
      t.db.close();
    }
  });
});

describe('issue #26 per-export directory', () => {
  it('writes the override directory and leaves settings.exportDir untouched', () => {
    const dataDir = makeTempDir('lf-issue26-dir-');
    const db = openDatabase(dataDir);
    try {
      const seeded = seedExportTask(db, dataDir);
      const settings = new SettingsStore(db);
      const savedRoot = makeTempDir('lf-issue26-saved-');
      const overrideRoot = makeTempDir('lf-issue26-override-');
      settings.update({ exportDir: savedRoot });

      const exported = exportTask(db, dataDir, seeded.taskId, new Date(), overrideRoot);
      expect(dirname(exported.directory)).toBe(overrideRoot);
      expect(settings.load().exportDir).toBe(savedRoot);
      expect(() => exportTask(db, dataDir, seeded.taskId, new Date(), 'relative/exports')).toThrow(
        ExportDirectoryError,
      );
    } finally {
      db.close();
    }
  });

  it('uses the request directory on the HTTP route and validates relative paths', async () => {
    const h = persistedRoutes();
    try {
      const seeded = seedExportTask(h.db, h.dataDir);
      const savedRoot = makeTempDir('lf-issue26-route-saved-');
      const overrideRoot = makeTempDir('lf-issue26-route-override-');
      h.settings.update({ exportDir: savedRoot });

      const exported = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        exportDir: overrideRoot,
      });
      expect(exported.status).toBe(200);
      const data = (exported.json() as { data: { directory: string; images: number } }).data;
      expect(data.images).toBe(3);
      expect(dirname(data.directory)).toBe(overrideRoot);
      expect(new SettingsStore(h.db).load().exportDir).toBe(savedRoot);

      const relative = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        exportDir: 'relative/exports',
      });
      expect(relative.status).toBe(400);
      expect(relative.json()).toMatchObject({ code: 'INVALID_EXPORT_DIR', message: '本次导出目录必须是绝对路径：relative/exports' });

      const blocked = writeFixtureFile(join(makeTempDir('lf-issue26-blocked-'), 'not-a-directory'), 'x');
      const unusable = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        exportDir: join(blocked, 'nested'),
      });
      expect(unusable.status).toBe(400);
      expect(unusable.json()).toMatchObject({ code: 'INVALID_EXPORT_DIR' });
      expect((unusable.json() as { message: string }).message).toContain('导出目录不可创建或不可写');
    } finally {
      h.db.close();
    }
  });

  it('uses the override on lf_export and rejects relative paths', async () => {
    const t = toolHarness();
    try {
      const seeded = seedExportTask(t.db, t.dataDir);
      const savedRoot = makeTempDir('lf-issue26-tool-saved-');
      const overrideRoot = makeTempDir('lf-issue26-tool-override-');
      t.settings.update({ exportDir: savedRoot });

      const exported = resultOf(
        await t.tool('lf_export').execute({ taskId: seeded.taskId, exportDir: overrideRoot }, fakeExec()),
      );
      expect(exported.status).toBe('OK');
      expect(dirname(String(exported.data.directory))).toBe(overrideRoot);
      expect(t.settings.load().exportDir).toBe(savedRoot);

      const failed = resultOf(
        await t.tool('lf_export').execute({ taskId: seeded.taskId, exportDir: 'relative/exports' }, fakeExec()),
      );
      expect(failed.status).toBe('ERROR');
      expect(failed.message).toBe('本次导出目录必须是绝对路径：relative/exports');
    } finally {
      t.db.close();
    }
  });
});

describe('issue #26 opening recorded exports', () => {
  it('opens a recently exported artifact from a custom directory and rejects unrecorded paths', async () => {
    const h = persistedRoutes();
    try {
      const seeded = seedExportTask(h.db, h.dataDir);
      const customRoot = makeTempDir('lf-issue26-open-custom-');
      const exported = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        exportDir: customRoot,
      });
      expect(exported.status).toBe(200);
      const directory = (exported.json() as { data: { directory: string } }).data.directory;

      const opened = await postJson(h.routes, '/api/local-frames/export/open', { path: directory });
      expect(opened.status).toBe(200);
      expect(h.opened).toEqual([directory]);

      const unrecordedSibling = join(customRoot, 'not-recorded');
      const sibling = await postJson(h.routes, '/api/local-frames/export/open', { path: unrecordedSibling });
      expect(sibling.status).toBe(403);
      const arbitrary = await postJson(h.routes, '/api/local-frames/export/open', {
        path: makeTempDir('lf-issue26-open-random-'),
      });
      expect(arbitrary.status).toBe(403);
      expect(arbitrary.json()).toMatchObject({ code: 'FORBIDDEN_PATH' });
    } finally {
      h.db.close();
    }
  });

  it('opens the recorded zip parent from a custom directory', async () => {
    const h = persistedRoutes();
    try {
      const seeded = seedExportTask(h.db, h.dataDir);
      const customRoot = makeTempDir('lf-issue26-open-zip-');
      const exported = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        exportDir: customRoot,
        zip: true,
      });
      expect(exported.status).toBe(200);
      const artifact = (exported.json() as { data: { directory: string; zip: boolean } }).data;
      expect(artifact.zip).toBe(true);

      const opened = await postJson(h.routes, '/api/local-frames/export/open', { path: artifact.directory });
      expect(opened.status).toBe(200);
      expect(h.opened).toEqual([customRoot]);
    } finally {
      h.db.close();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symlink escapes out of a recorded custom export', async () => {
    const h = persistedRoutes();
    try {
      const seeded = seedExportTask(h.db, h.dataDir);
      const customRoot = makeTempDir('lf-issue26-open-link-');
      const outside = makeTempDir('lf-issue26-open-link-outside-');
      writeFixtureFile(join(outside, 'secret.txt'), 'secret');
      const exported = await postJson(h.routes, '/api/local-frames/export', {
        taskId: seeded.taskId,
        exportDir: customRoot,
      });
      const directory = (exported.json() as { data: { directory: string } }).data.directory;
      symlinkSync(outside, join(directory, 'escape'));

      const escaped = await postJson(h.routes, '/api/local-frames/export/open', { path: join(directory, 'escape') });
      expect(escaped.status).toBe(403);
      expect(escaped.json()).toMatchObject({ code: 'FORBIDDEN_PATH' });
      expect(h.opened).toHaveLength(0);
    } finally {
      h.db.close();
    }
  });
});
