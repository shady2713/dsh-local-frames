import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, guard, requireMethod, sendJson } from './http.js';
import type { StatusSnapshot } from './types.js';

export interface RoutesDeps {
  buildStatus: () => Promise<StatusSnapshot>;
  log: (message: string) => void;
}

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    throw new HttpError(400, 'BAD_URL', 'invalid request URL');
  }
}

/**
 * `/api/local-frames/*`. The Web page fetches these with relative paths; the
 * guard enforces the loopback Host and same-origin rules from §12.3.
 */
export function createRoutes(
  deps: RoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> | void {
  return guard(deps.log, async (req, res) => {
    const pathname = pathnameOf(req);
    if (pathname === '/api/local-frames/status') {
      requireMethod(req, ['GET']);
      const snapshot = await deps.buildStatus();
      sendJson(res, 200, { status: 'OK', data: snapshot });
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', `no local-frames route for ${pathname}`);
  });
}
