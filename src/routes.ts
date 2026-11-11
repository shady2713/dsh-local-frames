import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocalFramesDatabase } from './db.js';
import { exportTask } from './export.js';
import { HttpError, guard, readJsonBody, requireMethod, sendJson } from './http.js';
import { describeIngest, ingestPaths } from './ingest.js';
import { nowIso } from './ids.js';
import { controlTask } from './pipeline.js';
import type { Pipeline } from './pipeline.js';
import { SettingsError, type SettingsStore } from './settings.js';
import type { EnvironmentReport, StatusSnapshot } from './types.js';

export interface RoutesDeps {
  buildStatus: () => Promise<StatusSnapshot>;
  log: (message: string) => void;
  db?: LocalFramesDatabase;
  settings?: SettingsStore;
  dataDir?: string;
  pipeline?: Pipeline;
  listModels?: () => Promise<Array<{ provider: string; model: string; name: string }>>;
  recheckEnvironment?: () => Promise<EnvironmentReport>;
}

interface Ready {
  db: LocalFramesDatabase;
  settings: SettingsStore;
  dataDir: string;
  pipeline: Pipeline;
}

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    throw new HttpError(400, 'BAD_URL', 'invalid request URL');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ready(deps: RoutesDeps): Ready {
  if (deps.db === undefined || deps.settings === undefined || deps.dataDir === undefined || deps.pipeline === undefined) {
    throw new HttpError(500, 'NOT_READY', '插件服务尚未就绪');
  }
  return { db: deps.db, settings: deps.settings, dataDir: deps.dataDir, pipeline: deps.pipeline };
}

function activeTaskId(db: LocalFramesDatabase): string | null {
  const row = db.raw
    .prepare(
      "SELECT task_id FROM tasks WHERE status IN ('RUNNING', 'PAUSED') ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { task_id?: string } | undefined;
  return typeof row?.task_id === 'string' ? row.task_id : null;
}

function latestDoneTask(db: LocalFramesDatabase): string | null {
  const row = db.raw
    .prepare("SELECT task_id FROM tasks WHERE status = 'DONE' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
    .get() as { task_id?: string } | undefined;
  return typeof row?.task_id === 'string' ? row.task_id : null;
}

/**
 * `/api/local-frames/*`. Pages fetch these with same-origin paths. The guard
 * enforces the loopback Host and same-origin rules from §12.3.
 */
export function createRoutes(
  deps: RoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> | void {
  return guard(deps.log, async (req, res) => {
    const pathname = pathnameOf(req);
    if (pathname === '/api/local-frames/status') {
      requireMethod(req, ['GET']);
      sendJson(res, 200, { status: 'OK', data: await deps.buildStatus() });
      return;
    }
    if (pathname === '/api/local-frames/models') {
      requireMethod(req, ['GET']);
      const models = deps.listModels === undefined ? [] : await deps.listModels();
      sendJson(res, 200, { status: 'OK', data: { models } });
      return;
    }
    if (pathname === '/api/local-frames/environment/recheck') {
      requireMethod(req, ['POST']);
      await readJsonBody(req);
      if (deps.recheckEnvironment === undefined) throw new HttpError(500, 'NOT_READY', '插件服务尚未就绪');
      sendJson(res, 200, { status: 'OK', data: await deps.recheckEnvironment() });
      return;
    }
    if (pathname === '/api/local-frames/settings') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      try {
        sendJson(res, 200, { status: 'OK', data: services.settings.update(body) });
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, 'INVALID_SETTINGS', error.message);
        throw error;
      }
      return;
    }
    if (pathname === '/api/local-frames/targets/archive') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.targetId !== 'string' || body.targetId.trim().length === 0) {
        throw new HttpError(400, 'INVALID_BODY', 'targetId 必须是字符串');
      }
      const result = services.db.raw
        .prepare('UPDATE targets SET archived = 1, updated_at = ? WHERE target_id = ?')
        .run(nowIso(), body.targetId.trim());
      if (result.changes === 0) throw new HttpError(404, 'NOT_FOUND', '对象不存在');
      sendJson(res, 200, { status: 'OK', data: { target_id: body.targetId.trim(), archived: true } });
      return;
    }
    if (pathname === '/api/local-frames/videos/add') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.path !== 'string') throw new HttpError(400, 'INVALID_BODY', 'path 必须是字符串');
      if (body.recursive !== undefined && typeof body.recursive !== 'boolean') {
        throw new HttpError(400, 'INVALID_BODY', 'recursive 必须是布尔值');
      }
      const taskId = activeTaskId(services.db);
      if (taskId === null) throw new HttpError(409, 'NO_TASK', '没有进行中或暂停的任务');
      const report = await ingestPaths(services.db, taskId, services.dataDir, services.settings.load().allowRoots, [
        { path: body.path, recursive: body.recursive !== false },
      ]);
      if (report.added.length === 0 && report.existing.length > 0 && report.rejected.length === 0) {
        throw new HttpError(409, 'EXISTS', '已存在');
      }
      if (report.added.length === 0) throw new HttpError(400, 'REJECTED', report.rejected[0]?.message ?? '没有可用的视频');
      services.pipeline.kick();
      sendJson(res, 200, { status: 'OK', message: describeIngest(report), data: report });
      return;
    }
    if (pathname === '/api/local-frames/control') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.taskId !== 'string' || typeof body.action !== 'string') {
        throw new HttpError(400, 'INVALID_BODY', '需要 taskId 和 action');
      }
      const result = controlTask(services.db, services.dataDir, body.taskId, body.action);
      if (!result.ok) throw new HttpError(409, 'BAD_STATE', result.message);
      if (body.action === 'resume') services.pipeline.kick();
      sendJson(res, 200, { status: 'OK', message: result.message, data: { task_id: body.taskId, task_status: result.status } });
      return;
    }
    if (pathname === '/api/local-frames/export') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      const requested = isRecord(body) && typeof body.taskId === 'string' ? body.taskId.trim() : '';
      const taskId = requested.length > 0 ? requested : (activeTaskId(services.db) ?? latestDoneTask(services.db));
      if (taskId === null) throw new HttpError(404, 'NO_TASK', '没有可导出的任务');
      const exported = exportTask(services.db, services.dataDir, taskId, new Date(), services.settings.load().exportDir);
      sendJson(res, 200, { status: 'OK', data: { task_id: taskId, ...exported } });
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', `no local-frames route for ${pathname}`);
  });
}
