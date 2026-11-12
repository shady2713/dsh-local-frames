import { realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import type { LocalFramesDatabase } from './db.js';
import { ExportSelectionError, exportTask, recentExportFrom, rememberRecentExport } from './export.js';
import { HttpError, guard, readJsonBody, requireMethod, sendJson } from './http.js';
import { describeIngest, acceptedCount, ingestPaths } from './ingest.js';
import { nowIso } from './ids.js';
import { controlTask } from './pipeline.js';
import type { Pipeline } from './pipeline.js';
import { RetryError, retryTaskFailures } from './retry.js';
import { SettingsError, type SettingsStore } from './settings.js';
import { listTaskSummaries } from './status.js';
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
  /** Injected host file-manager opener; tests replace it, production uses `ctx.subprocess`. */
  openPath?: (directory: string) => Promise<void>;
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
    if (pathname === '/api/local-frames/tasks') {
      requireMethod(req, ['GET']);
      const services = ready(deps);
      sendJson(res, 200, { status: 'OK', data: { tasks: listTaskSummaries(services.db) } });
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
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        throw new HttpError(400, 'INVALID_BODY', 'force 必须是布尔值');
      }
      const importPath = body.path.trim();
      // Remember the path users actually submitted so the progress page can
      // refill it after a reload. Relative paths are rejected by ingest.
      if (isAbsolute(importPath)) {
        try {
          services.settings.update({ lastImportPath: importPath });
        } catch (error) {
          if (error instanceof SettingsError) throw new HttpError(400, 'INVALID_SETTINGS', error.message);
          throw error;
        }
      }
      const taskId = activeTaskId(services.db);
      if (taskId === null) throw new HttpError(409, 'NO_TASK', '没有进行中或暂停的任务');
      const report = await ingestPaths(
        services.db,
        taskId,
        services.dataDir,
        services.settings.load().allowRoots,
        [{ path: importPath, recursive: body.recursive !== false }],
        { force: body.force === true },
      );
      if (acceptedCount(report) === 0) {
        if (report.existing.length > 0 && report.rejected.length === 0) {
          throw new HttpError(409, 'EXISTS', '已存在');
        }
        throw new HttpError(400, 'REJECTED', report.rejected[0]?.message ?? '没有可用的视频');
      }
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
    if (pathname === '/api/local-frames/retry') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.taskId !== 'string' || body.taskId.trim().length === 0) {
        throw new HttpError(400, 'INVALID_BODY', 'taskId 必须是非空字符串');
      }
      if (body.all !== undefined && typeof body.all !== 'boolean') {
        throw new HttpError(400, 'INVALID_BODY', 'all 必须是布尔值');
      }
      const readIds = (value: unknown, field: string): string[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > 500) {
          throw new HttpError(400, 'INVALID_BODY', `${field} 必须是最多 500 个字符串的数组`);
        }
        const ids: string[] = [];
        for (const entry of value) {
          if (typeof entry !== 'string' || entry.trim().length === 0) {
            throw new HttpError(400, 'INVALID_BODY', `${field} 必须是非空字符串数组`);
          }
          const id = entry.trim();
          if (!ids.includes(id)) ids.push(id);
        }
        return ids;
      };
      const itemIds = readIds(body.itemIds, 'itemIds');
      const frameIds = readIds(body.frameIds, 'frameIds');
      if (body.all !== true && itemIds.length === 0 && frameIds.length === 0) {
        throw new HttpError(400, 'INVALID_BODY', '需要 itemIds、frameIds 或 all=true');
      }
      let result;
      try {
        result = retryTaskFailures(services.db, services.dataDir, body.taskId.trim(), {
          itemIds,
          frameIds,
          all: body.all === true,
        });
      } catch (error) {
        if (error instanceof RetryError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
      services.pipeline.kick();
      const parts = [`已重试 ${result.items_retried.length} 个失败视频、${result.frames_retried.length} 个失败帧`];
      if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 项`);
      sendJson(res, 200, { status: 'OK', message: parts.join('；'), data: result });
      return;
    }
    if (pathname === '/api/local-frames/export') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      const record = isRecord(body) ? body : {};
      if (record.zip !== undefined && typeof record.zip !== 'boolean') {
        throw new HttpError(400, 'INVALID_BODY', 'zip 必须是布尔值');
      }
      if (record.byObject !== undefined && typeof record.byObject !== 'boolean') {
        throw new HttpError(400, 'INVALID_BODY', 'byObject 必须是布尔值');
      }
      let targetIds: string[] | null = null;
      if (record.targetIds !== undefined) {
        if (!Array.isArray(record.targetIds) || record.targetIds.length > 100) {
          throw new HttpError(400, 'INVALID_BODY', 'targetIds 必须是最多 100 个字符串的数组');
        }
        targetIds = [];
        for (const entry of record.targetIds) {
          if (typeof entry !== 'string' || entry.trim().length === 0) {
            throw new HttpError(400, 'INVALID_BODY', 'targetIds 必须是非空字符串数组');
          }
          const id = entry.trim();
          if (!targetIds.includes(id)) targetIds.push(id);
        }
      }
      const requested = typeof record.taskId === 'string' ? record.taskId.trim() : '';
      const taskId = requested.length > 0 ? requested : (activeTaskId(services.db) ?? latestDoneTask(services.db));
      if (taskId === null) throw new HttpError(404, 'NO_TASK', '没有可导出的任务');
      let exported;
      try {
        exported = exportTask(services.db, services.dataDir, taskId, new Date(), services.settings.load().exportDir, {
          targetIds,
          zip: record.zip === true,
          byObject: record.byObject === true,
        });
      } catch (error) {
        if (error instanceof ExportSelectionError) throw new HttpError(400, 'INVALID_TARGETS', error.message);
        throw new HttpError(500, 'EXPORT_FAILED', error instanceof Error ? error.message : String(error));
      }
      const recentExports = rememberRecentExport(services.settings, recentExportFrom(exported, taskId));
      sendJson(res, 200, { status: 'OK', data: { task_id: taskId, ...exported, recentExports } });
      return;
    }
    if (pathname === '/api/local-frames/export/open') {
      requireMethod(req, ['POST']);
      const services = ready(deps);
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.path !== 'string' || body.path.trim().length === 0) {
        throw new HttpError(400, 'INVALID_BODY', 'path 必须是非空字符串');
      }
      const requested = body.path.trim();
      if (!isAbsolute(requested)) throw new HttpError(400, 'INVALID_PATH', 'path 必须是绝对路径');
      const exportRoot = services.settings.load().exportDir ?? resolve(services.dataDir, 'exports');
      const target = resolve(normalize(requested));
      const root = resolve(normalize(exportRoot));
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        throw new HttpError(403, 'FORBIDDEN_PATH', '只能打开导出目录内的导出结果');
      }
      // A lexical prefix check is not enough: a symlink inside exportDir can
      // resolve anywhere. Re-check the canonical paths and open the canonical
      // result, so a link swapped after the check cannot change the target.
      let canonical: string;
      try {
        canonical = realpathSync(target);
      } catch {
        throw new HttpError(404, 'NOT_FOUND', '导出结果不存在');
      }
      let canonicalRoot: string;
      try {
        canonicalRoot = realpathSync(root);
      } catch {
        throw new HttpError(403, 'FORBIDDEN_PATH', '只能打开导出目录内的导出结果');
      }
      const insideRoot = (path: string): boolean => path === canonicalRoot || path.startsWith(`${canonicalRoot}${sep}`);
      if (!insideRoot(canonical)) {
        throw new HttpError(403, 'FORBIDDEN_PATH', '只能打开导出目录内的导出结果');
      }
      let directory: string;
      try {
        const stat = statSync(canonical);
        directory = stat.isDirectory() ? canonical : dirname(canonical);
      } catch {
        throw new HttpError(404, 'NOT_FOUND', '导出结果不存在');
      }
      if (!insideRoot(directory)) {
        throw new HttpError(403, 'FORBIDDEN_PATH', '只能打开导出目录内的导出结果');
      }
      if (deps.openPath === undefined) throw new HttpError(500, 'NOT_READY', '当前环境无法打开目录');
      try {
        await deps.openPath(directory);
      } catch (error) {
        throw new HttpError(409, 'OPEN_FAILED', error instanceof Error ? error.message : String(error));
      }
      sendJson(res, 200, { status: 'OK', data: { path: target, directory, opened: true } });
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', `no local-frames route for ${pathname}`);
  });
}
