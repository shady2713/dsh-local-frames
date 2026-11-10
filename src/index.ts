import { join, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { openDatabase } from './db.js';
import { createFfmpegMedia } from './media.js';
import { clearTmp, Pipeline } from './pipeline.js';
import { createRoutes } from './routes.js';
import { Scheduler } from './scheduler.js';
import { SettingsStore } from './settings.js';
import { buildStatus } from './status.js';
import { createTools, type ToolDefinition } from './tool.js';
import {
  assertSupportedRuntime,
  defaultDataDir,
  EnvironmentChecker,
  readDshVersion,
  type VersionSubprocess,
} from './versions.js';
import { pluginVersion } from './version.js';
import { createHostVision, type AttachmentStoreLike, type LlmStreamLike } from './vision.js';

export const name = 'local-frames';

/** `tools` and `subprocess` are required; `webServer` and `profileContext` are optional. */
export const inject = ['tools', 'subprocess'];

export interface PluginConfig {
  dataDir?: string;
}

/** The single plugin config field is the data directory; all other settings live in SQLite. */
export const Config = Schema.object({
  dataDir: Schema.string()
    .default(defaultDataDir())
    .description('Plugin data directory (db.sqlite, frames/, exports/, tmp/).'),
});

interface PluginLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

interface WebRouteLike {
  kind: 'prefix';
  path: string;
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void;
}

interface ServiceScope {
  tools: { register(definition: ToolDefinition): (() => void) | void };
  subprocess: VersionSubprocess;
  webServer?: { register(route: WebRouteLike): () => void | Promise<void> };
  effect(callback: () => () => void): void;
  inject(dependencies: string[], callback: (scope: ServiceScope) => void): void;
  get(service: string, optional?: boolean): unknown;
}

interface PluginContext extends ServiceScope {
  logger?(name?: string): PluginLogger;
}

function resolveDataDir(config: PluginConfig): string {
  const configured = config.dataDir ?? defaultDataDir();
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw new Error('local-frames: dataDir must be a non-empty path');
  }
  return resolve(configured.trim());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalService(ctx: ServiceScope, name: string): unknown {
  try {
    return ctx.get(name, true);
  } catch {
    return undefined;
  }
}

export function apply(ctx: PluginContext, config: PluginConfig = {}): void {
  const logger = ctx.logger?.(name);
  const log = (message: string): void => {
    if (logger?.info !== undefined) logger.info(message);
    else if (logger?.error !== undefined) logger.error(message);
  };
  const logError = (message: string): void => {
    if (logger?.error !== undefined) logger.error(message);
    else console.error(`[${name}] ${message}`);
  };

  const dshVersion = readDshVersion(ctx.get('profileContext', false));
  assertSupportedRuntime(process.version, dshVersion);

  const dataDir = resolveDataDir(config);
  const database = openDatabase(dataDir);
  const settings = new SettingsStore(database, logError);
  const version = pluginVersion();
  const environment = new EnvironmentChecker({
    subprocess: ctx.subprocess,
    dataDir,
    dshVersion,
  });

  // §15.1: the same checks run at plugin start and on every lf_status call.
  void environment
    .check(false)
    .then((report) => {
      if (!report.ok) {
        const problems = report.checks
          .filter((check) => check.blocking && check.status !== 'OK')
          .map((check) => `${check.label}: ${check.detail ?? check.status}`);
        logError(`environment check failed: ${problems.join('; ')}`);
      } else {
        log(`environment OK (${version})`);
      }
    })
    .catch((error: unknown) => logError(`environment check failed: ${errorText(error)}`));

  const currentStatus = (freshEnvironment: boolean) =>
    buildStatus({
      db: database,
      settings,
      environment,
      dataDir,
      freshEnvironment,
      pluginVersion: version,
    });

  const media = createFfmpegMedia(ctx.subprocess, dataDir);
  const vision = createHostVision({
    llm: () => {
      const service = optionalService(ctx, 'llm');
      return service === undefined || service === null ? null : (service as LlmStreamLike);
    },
    attachments: () => {
      const service = optionalService(ctx, 'attachments');
      return service === undefined || service === null ? null : (service as AttachmentStoreLike);
    },
    media,
    tmpDir: join(dataDir, 'tmp'),
  });
  const pipeline = new Pipeline({
    db: database,
    settings,
    dataDir,
    media,
    vision,
    log: logError,
  });
  const scheduler = new Scheduler(pipeline);

  const toolDisposers: Array<() => void> = [];
  let closed = false;
  ctx.effect(() => {
    const tools = createTools({
      db: database,
      settings,
      buildStatus: currentStatus,
      log: logError,
      dataDir,
      pipeline,
      environment,
    });
    for (const tool of tools) {
      const dispose = ctx.tools.register(tool);
      if (typeof dispose === 'function') toolDisposers.push(dispose);
    }
    void clearTmp(dataDir)
      .then(() => {
        if (!closed) scheduler.start();
      })
      .catch((error: unknown) => logError(`清空临时目录失败：${errorText(error)}`));
    return () => {
      closed = true;
      scheduler.stop();
      pipeline.stop();
      for (const dispose of toolDisposers) dispose();
      database.close();
    };
  });

  ctx.inject(['webServer'], (scope) => {
    if (scope.webServer === undefined) return;
    scope.effect(() => {
      const dispose = scope.webServer?.register({
        kind: 'prefix',
        path: '/api/local-frames',
        handler: createRoutes({
          buildStatus: () => currentStatus(false),
          log,
          db: database,
          settings,
          dataDir,
          pipeline,
          listModels: () => vision.listImageModels(),
          recheckEnvironment: () => environment.check(true),
        }),
      });
      return () => {
        if (typeof dispose === 'function') void dispose();
      };
    });
  });
}
