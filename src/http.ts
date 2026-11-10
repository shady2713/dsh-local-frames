import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 1_048_576;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) throw new HttpError(403, 'FORBIDDEN_HOST', 'invalid Host header');
    const rest = host.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) {
      throw new HttpError(403, 'FORBIDDEN_HOST', 'invalid Host header');
    }
    return host.slice(1, end);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** Plugin HTTP is loopback-only; a non-loopback Host is refused even on a local socket. */
export function assertLoopbackHost(req: IncomingMessage): void {
  const header = req.headers.host;
  if (typeof header !== 'string' || header.length === 0) {
    throw new HttpError(403, 'FORBIDDEN_HOST', 'missing Host header');
  }
  const hostname = hostnameOf(header);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    throw new HttpError(403, 'FORBIDDEN_HOST', 'Host must be a loopback address');
  }
}

/**
 * Origin, when present, must be the same origin as Host. A missing Origin is
 * accepted for local command-line checks; the Host fence still applies.
 */
export function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'invalid Origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'invalid Origin');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Origin must be an http(s) origin');
  }
  const host = req.headers.host;
  if (typeof host !== 'string' || parsed.host.toLowerCase() !== host.trim().toLowerCase()) {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Origin must match Host');
  }
}

export function requireMethod(req: IncomingMessage, methods: readonly string[]): void {
  const method = req.method ?? 'GET';
  if (methods.includes(method)) return;
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', `method must be ${methods.join(' or ')}`);
}

/** Write endpoints accept only application/json, optionally with a charset parameter. */
export function assertJsonContentType(req: IncomingMessage): void {
  const header = req.headers['content-type'];
  if (typeof header !== 'string') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const mediaType = header.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  assertJsonContentType(req);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) throw new HttpError(400, 'INVALID_JSON', 'request body is empty');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * Apply the HTTP fence (§12.3) and convert thrown {@link HttpError}s into JSON
 * errors. Every plugin route goes through this wrapper.
 */
export function guard(log: (message: string) => void, handler: Handler): Handler {
  return async (req, res) => {
    const started = Date.now();
    try {
      assertLoopbackHost(req);
      assertSameOrigin(req);
      if ((req.method ?? 'GET') !== 'GET') assertJsonContentType(req);
      await handler(req, res);
      log(`${req.method ?? 'GET'} ${(req.url ?? '').split('?')[0] ?? ''} ${res.statusCode} ${Date.now() - started}ms`);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { status: 'ERROR', code: error.code, message: error.message });
      } else {
        log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
        sendJson(res, 500, { status: 'ERROR', code: 'INTERNAL', message: 'internal error' });
      }
    }
  };
}
