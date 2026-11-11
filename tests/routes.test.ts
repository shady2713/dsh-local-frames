import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import type { Pipeline } from '../src/pipeline.js';
import { createRoutes } from '../src/routes.js';
import { SettingsStore } from '../src/settings.js';
import type { StatusSnapshot } from '../src/types.js';
import { makeTempDir, mockRequest, mockResponse, writeFixtureFile } from './helpers.js';

const snapshot = {
  plugin: { id: 'local-frames', version: '0.1.0' },
  settings: {
    model: null,
    dataDirLimitGb: 50,
    budgetPerTask: 3000,
    frameIntervalSeconds: 2,
    visionConcurrency: 2,
    exportDir: null,
    lastImportPath: null,
    allowRoots: [],
  },
  targets: [],
  task: null,
  funnel: { imported: 0, probed: 0, frames: 0, duplicatesSkipped: 0, judged: 0, exportable: 0, errors: 0 },
  errors: [],
  pause: null,
  dataDir: { path: '/tmp/local-frames', usedBytes: 0, limitGb: 50, freeGb: 100 },
  environment: { ok: true, checks: [], missing: [], checkedAt: '2026-01-01T00:00:00.000Z' },
} satisfies StatusSnapshot;

function routes(): ReturnType<typeof createRoutes> {
  return createRoutes({ buildStatus: async () => snapshot, log: () => undefined });
}

function persistedRoutes(): {
  db: ReturnType<typeof openDatabase>;
  settings: SettingsStore;
  routes: ReturnType<typeof createRoutes>;
} {
  const dataDir = makeTempDir('lf-routes-data-');
  const db = openDatabase(dataDir);
  const settings = new SettingsStore(db);
  const pipeline = { kick: () => undefined } as unknown as Pipeline;
  const persistent = createRoutes({
    buildStatus: async () => snapshot,
    log: () => undefined,
    db,
    settings,
    dataDir,
    pipeline,
  });
  return { db, settings, routes: persistent };
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

describe('plugin HTTP routes', () => {
  it('serves the status snapshot on the loopback origin', async () => {
    const { res, result } = mockResponse();
    await routes()(mockRequest({ url: '/api/local-frames/status', headers: { host: '127.0.0.1:3080' } }), res);
    expect(result.status).toBe(200);
    expect(result.json()).toEqual({ status: 'OK', data: snapshot });
  });

  it('refuses a non-loopback Host', async () => {
    const { res, result } = mockResponse();
    await routes()(mockRequest({ url: '/api/local-frames/status', headers: { host: 'example.com' } }), res);
    expect(result.status).toBe(403);
    expect(result.json()).toMatchObject({ status: 'ERROR', code: 'FORBIDDEN_HOST' });
  });

  it('refuses a cross-origin request', async () => {
    const { res, result } = mockResponse();
    await routes()(
      mockRequest({
        url: '/api/local-frames/status',
        headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
      }),
      res,
    );
    expect(result.status).toBe(403);
    expect(result.json()).toMatchObject({ status: 'ERROR', code: 'FORBIDDEN_ORIGIN' });
  });

  it('accepts a same-origin request', async () => {
    const { res, result } = mockResponse();
    await routes()(
      mockRequest({
        url: '/api/local-frames/status',
        headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      }),
      res,
    );
    expect(result.status).toBe(200);
  });

  it('rejects unknown paths, wrong methods, and non-JSON writes', async () => {
    const unknown = mockResponse();
    await routes()(mockRequest({ url: '/api/local-frames/nope', headers: { host: '127.0.0.1:1' } }), unknown.res);
    expect(unknown.result.status).toBe(404);

    const wrongMethod = mockResponse();
    await routes()(
      mockRequest({
        method: 'POST',
        url: '/api/local-frames/status',
        headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
        body: '{}',
      }),
      wrongMethod.res,
    );
    expect(wrongMethod.result.status).toBe(405);

    const plain = mockResponse();
    await routes()(
      mockRequest({
        method: 'POST',
        url: '/api/local-frames/status',
        headers: { host: '127.0.0.1:1', 'content-type': 'text/plain' },
        body: 'x',
      }),
      plain.res,
    );
    expect(plain.result.status).toBe(415);
  });
});

describe('path settings persistence', () => {
  it('saves the allowlist on the first settings write and keeps it after reopening', async () => {
    const h = persistedRoutes();
    try {
      const root = makeTempDir('lf-routes-root-');
      const result = await postJson(h.routes, '/api/local-frames/settings', { allowRoots: [root] });
      expect(result.status).toBe(200);
      expect((result.json() as { data: { allowRoots: string[] } }).data.allowRoots).toEqual([root]);
      expect(new SettingsStore(h.db).load().allowRoots).toEqual([root]);
    } finally {
      h.db.close();
    }
  });

  it('persists the judgment concurrency and rejects values outside 1..8', async () => {
    const h = persistedRoutes();
    try {
      const saved = await postJson(h.routes, '/api/local-frames/settings', { visionConcurrency: 5 });
      expect(saved.status).toBe(200);
      expect(new SettingsStore(h.db).load().visionConcurrency).toBe(5);
      const invalid = await postJson(h.routes, '/api/local-frames/settings', { visionConcurrency: 9 });
      expect(invalid.status).toBe(400);
      expect(new SettingsStore(h.db).load().visionConcurrency).toBe(5);
    } finally {
      h.db.close();
    }
  });

  it('rejects relative paths with a clear reason and persists the export directory', async () => {
    const h = persistedRoutes();
    try {
      const invalid = await postJson(h.routes, '/api/local-frames/settings', { allowRoots: ['relative/media'] });
      expect(invalid.status).toBe(400);
      expect(invalid.json()).toMatchObject({ status: 'ERROR', code: 'INVALID_SETTINGS' });
      expect(String((invalid.json() as { message: string }).message)).toContain('must be absolute');

      const exportDir = makeTempDir('lf-routes-export-');
      const saved = await postJson(h.routes, '/api/local-frames/settings', { exportDir });
      expect(saved.status).toBe(200);
      expect(new SettingsStore(h.db).load().exportDir).toBe(exportDir);
    } finally {
      h.db.close();
    }
  });

  it('remembers the last import path submitted from the progress page', async () => {
    const h = persistedRoutes();
    try {
      const root = makeTempDir('lf-routes-media-');
      h.settings.update({ allowRoots: [root] });
      const file = writeFixtureFile(join(root, 'clip.mp4'), 'clip');
      const now = new Date().toISOString();
      h.db.raw
        .prepare('INSERT INTO tasks (task_id, spec_json, progress_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-1', '{}', '{}', 'RUNNING', now, now);
      const result = await postJson(h.routes, '/api/local-frames/videos/add', { path: file });
      expect(result.status).toBe(200);
      expect(new SettingsStore(h.db).load().lastImportPath).toBe(file);
    } finally {
      h.db.close();
    }
  });
});
