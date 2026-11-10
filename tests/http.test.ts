import { describe, expect, it } from 'vitest';
import {
  assertJsonContentType,
  assertLoopbackHost,
  assertSameOrigin,
  guard,
  HttpError,
  readJsonBody,
  requireMethod,
  sendJson,
} from '../src/http.js';
import { mockRequest, mockResponse } from './helpers.js';

describe('http fence', () => {
  it('accepts loopback hosts only', () => {
    expect(() => assertLoopbackHost(mockRequest({ headers: { host: '127.0.0.1:1234' } }))).not.toThrow();
    expect(() => assertLoopbackHost(mockRequest({ headers: { host: 'localhost:1234' } }))).not.toThrow();
    expect(() => assertLoopbackHost(mockRequest({ headers: { host: '[::1]:1234' } }))).not.toThrow();
    expect(() => assertLoopbackHost(mockRequest({ headers: { host: '[::1]evil' } }))).toThrow(HttpError);
    expect(() => assertLoopbackHost(mockRequest({ headers: { host: 'example.com' } }))).toThrow(/loopback/);
    expect(() => assertLoopbackHost(mockRequest({ headers: {} }))).toThrow(/missing Host/);
  });

  it('accepts a missing Origin and rejects a mismatched or non-http Origin', () => {
    const host = { host: '127.0.0.1:1234' };
    expect(() => assertSameOrigin(mockRequest({ headers: host }))).not.toThrow();
    expect(() =>
      assertSameOrigin(mockRequest({ headers: { ...host, origin: 'http://127.0.0.1:1234' } })),
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(mockRequest({ headers: { ...host, origin: 'http://evil.example' } })),
    ).toThrow(/match Host/);
    expect(() =>
      assertSameOrigin(mockRequest({ headers: { ...host, origin: 'file://127.0.0.1:1234' } })),
    ).toThrow(/Origin/);
  });

  it('allows only GET or JSON write bodies', () => {
    expect(() => requireMethod(mockRequest({ method: 'GET' }), ['GET'])).not.toThrow();
    expect(() => requireMethod(mockRequest({ method: 'POST' }), ['GET'])).toThrow(/method must be GET/);
    expect(() => assertJsonContentType(mockRequest({ headers: { 'content-type': 'application/json' } }))).not.toThrow();
    expect(() =>
      assertJsonContentType(mockRequest({ headers: { 'content-type': 'application/json; charset=utf-8' } })),
    ).not.toThrow();
    expect(() =>
      assertJsonContentType(mockRequest({ headers: { 'content-type': 'application/merge-patch+json' } })),
    ).toThrow(/application\/json/);
    expect(() => assertJsonContentType(mockRequest({ headers: {} }))).toThrow(/application\/json/);
  });

  it('reads a JSON body and rejects malformed, empty or oversized bodies', async () => {
    await expect(
      readJsonBody(mockRequest({ headers: { 'content-type': 'application/json' }, body: '{"a":1}' })),
    ).resolves.toEqual({ a: 1 });
    await expect(
      readJsonBody(mockRequest({ headers: { 'content-type': 'application/json' }, body: '' })),
    ).rejects.toThrow(/empty/);
    await expect(
      readJsonBody(mockRequest({ headers: { 'content-type': 'application/json' }, body: '{' })),
    ).rejects.toThrow(/valid JSON/);
    const huge = 'x'.repeat(1_048_577);
    await expect(
      readJsonBody(mockRequest({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(huge) })),
    ).rejects.toThrow(/too large/);
  });

  it('turns HttpError into a JSON error response', async () => {
    const { res, result } = mockResponse();
    const handler = guard(
      () => undefined,
      async () => {
        throw new HttpError(403, 'FORBIDDEN_HOST', 'bad host');
      },
    );
    await handler(mockRequest({ headers: { host: '127.0.0.1:1' } }), res);
    expect(result.status).toBe(403);
    expect(result.json()).toEqual({ status: 'ERROR', code: 'FORBIDDEN_HOST', message: 'bad host' });
  });

  it('turns an unexpected error into a 500 without leaking its message', async () => {
    const { res, result } = mockResponse();
    const handler = guard(
      () => undefined,
      async () => {
        throw new Error('secret detail');
      },
    );
    await handler(mockRequest({ headers: { host: '127.0.0.1:1' } }), res);
    expect(result.status).toBe(500);
    expect(result.body).not.toContain('secret detail');
  });

  it('sends JSON with no-store and nosniff headers', () => {
    const { res, result } = mockResponse();
    sendJson(res, 200, { ok: true });
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.json()).toEqual({ ok: true });
  });
});
