import { describe, expect, it } from 'vitest';
import { createRoutes } from '../src/routes.js';
import type { StatusSnapshot } from '../src/types.js';
import { mockRequest, mockResponse } from './helpers.js';

const snapshot = {
  plugin: { id: 'local-frames', version: '0.1.0' },
  settings: { model: null, dataDirLimitGb: 50, budgetPerTask: 3000, frameIntervalSeconds: 2, allowRoots: [] },
  targets: [],
  task: null,
  funnel: { imported: 0, probed: 0, frames: 0, duplicatesSkipped: 0, judged: 0, exportable: 0, errors: 0 },
  dataDir: { path: '/tmp/local-frames', usedBytes: 0, limitGb: 50, freeGb: 100 },
  environment: { ok: true, checks: [], missing: [], checkedAt: '2026-01-01T00:00:00.000Z' },
} satisfies StatusSnapshot;

function routes(): ReturnType<typeof createRoutes> {
  return createRoutes({ buildStatus: async () => snapshot, log: () => undefined });
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
