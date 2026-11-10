import { unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_MIN_FREE_DISK_GB, freeDiskGb } from './disk.js';
import type { CheckStatus, EnvironmentCheck, EnvironmentCheckId, EnvironmentReport } from './types.js';

/** Required DSH range (§15). */
export const DSH_VERSION_RANGE = '>=0.2.1-rc.2 <0.3.0';
export const NODE_MIN_VERSION = '22.13.0';
/** Recommendation only; an older executable is reported but does not block tasks. */
export const FFMPEG_RECOMMENDED_VERSION = '6.0.0';

const PROBE_TIMEOUT_MS = 5_000;

interface CollectedStream {
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean };
}

export interface SubprocessHandleLike {
  collected: { stdout: CollectedStream; stderr: CollectedStream };
  done: Promise<{ exitCode: number | null; signal: string | null }>;
  terminate(): void;
}

export interface SubprocessSpawnSpecLike {
  argv: string[];
  cwd: string;
  stdio: {
    stdin: 'ignore';
    stdout: { maxBytes: number };
    stderr: { maxBytes: number };
  };
  graceMs: number;
}

export interface VersionSubprocess {
  resolveExecutable(command: string): Promise<string | null>;
  spawn(spec: SubprocessSpawnSpecLike): SubprocessHandleLike;
}

export interface EnvironmentDeps {
  subprocess: VersionSubprocess;
  dataDir: string;
  nodeVersion?: string;
  /** DSH CLI version; read by the plugin from its profile's install anchor. */
  dshVersion?: string | null;
  platform?: NodeJS.Platform;
  freeGb?: (dir: string) => number | null;
  now?: () => Date;
}

interface ProbeResult {
  found: boolean;
  path: string | null;
  version: string | null;
  detail: string | null;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

/** Parse a leading semver core, tolerating `v` prefixes and build suffixes. */
export function parseSemver(text: string | null | undefined): ParsedVersion | null {
  if (typeof text !== 'string') return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.').filter((part) => part.length > 0);
  return { core: [major, minor, patch], prerelease };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  // A release sorts after all of its prereleases.
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Semver comparison; returns -1, 0 or 1, or null when either side is unparsable. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  const prerelease = comparePrerelease(a.prerelease, b.prerelease);
  return prerelease < 0 ? -1 : prerelease > 0 ? 1 : 0;
}

export function meetsMinimum(version: string, minimum: string): boolean {
  const comparison = compareVersions(version, minimum);
  return comparison !== null && comparison >= 0;
}

export function withinDshRange(version: string): boolean {
  const lower = compareVersions(version, '0.2.1-rc.2');
  const upper = compareVersions(version, '0.3.0');
  return lower !== null && upper !== null && lower >= 0 && upper < 0;
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  return line === undefined || line.length === 0 ? null : line;
}

/** Extract the first version-looking token from `--version` output. */
export function parseVersionOutput(text: string): string | null {
  const line = firstLine(text);
  if (line === null) return null;
  const match = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(line);
  return match?.[1] ?? line;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Probe one executable's version through ctx.subprocess; missing executables never throw. */
async function probeCommand(
  subprocess: VersionSubprocess,
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<ProbeResult> {
  let path: string | null;
  try {
    const resolved = await subprocess.resolveExecutable(command);
    path = typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  } catch (error) {
    return { found: false, path: null, version: null, detail: errorMessage(error) };
  }
  if (path === null) {
    return { found: false, path: null, version: null, detail: `${command} was not found on PATH` };
  }

  let handle: SubprocessHandleLike | null = null;
  try {
    handle = subprocess.spawn({
      argv: [path, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8_192 },
        stderr: { maxBytes: 8_192 },
      },
      graceMs: PROBE_TIMEOUT_MS,
    });
    const outcome = await withTimeout(handle.done, PROBE_TIMEOUT_MS);
    const stdout = handle.collected.stdout.readFrom(0).text;
    const stderr = handle.collected.stderr.readFrom(0).text;
    if (outcome.exitCode !== 0) {
      return {
        found: true,
        path,
        version: null,
        detail: firstLine(stderr) ?? `${command} exited with code ${outcome.exitCode ?? 'null'}`,
      };
    }
    const version = parseVersionOutput(stdout);
    return {
      found: true,
      path,
      version,
      detail: version === null ? `${command} printed no version` : null,
    };
  } catch (error) {
    if (handle !== null) {
      try {
        handle.terminate();
      } catch {
        // best effort
      }
    }
    return { found: true, path, version: null, detail: errorMessage(error) };
  }
}

function installHint(id: EnvironmentCheckId, platform: NodeJS.Platform): string | null {
  const linux = 'sudo apt-get update && sudo apt-get install -y';
  switch (id) {
    case 'node':
    case 'npm':
      if (platform === 'win32') return 'winget install --id OpenJS.NodeJS.LTS -e';
      if (platform === 'darwin') return 'brew install node@22 && brew link --overwrite node@22';
      return '使用 NodeSource 或 nvm 安装 Node 22，安装后确认 node --version >= 22.13';
    case 'ffmpeg':
    case 'ffprobe':
      if (platform === 'win32') return 'winget install --id Gyan.FFmpeg -e';
      if (platform === 'darwin') return 'brew install ffmpeg';
      return `${linux} ffmpeg`;
    case 'git':
      if (platform === 'win32') return 'winget install --id Git.Git -e';
      if (platform === 'darwin') return 'brew install git';
      return `${linux} git`;
    case 'dsh':
      return `按 DSH 官方方式升级到 ${DSH_VERSION_RANGE}`;
    case 'dataDir':
      return '检查数据目录写权限，并预留至少 10 GB 剩余空间';
  }
}

function checkRow(
  id: EnvironmentCheckId,
  label: string,
  required: string,
  status: CheckStatus,
  blocking: boolean,
  platform: NodeJS.Platform,
  fields: { version?: string | null; path?: string | null; detail?: string | null } = {},
): EnvironmentCheck {
  return {
    id,
    label,
    required,
    status,
    version: fields.version ?? null,
    path: fields.path ?? null,
    blocking,
    detail: fields.detail ?? null,
    install: status === 'OK' ? null : installHint(id, platform),
  };
}

function nodeCheck(version: string, platform: NodeJS.Platform): EnvironmentCheck {
  const ok = meetsMinimum(version, NODE_MIN_VERSION);
  return checkRow(
    'node',
    'Node.js',
    `>=${NODE_MIN_VERSION}`,
    ok ? 'OK' : 'TOO_OLD',
    true,
    platform,
    { version, detail: ok ? null : `需要 Node.js >= ${NODE_MIN_VERSION}` },
  );
}

function dshCheck(version: string | null, platform: NodeJS.Platform): EnvironmentCheck {
  if (version === null) {
    return checkRow('dsh', 'DSH', DSH_VERSION_RANGE, 'MISSING', true, platform, {
      detail: '无法读取 DSH 版本（缺少 profileContext.installAnchor）',
    });
  }
  const ok = withinDshRange(version);
  return checkRow('dsh', 'DSH', DSH_VERSION_RANGE, ok ? 'OK' : 'TOO_OLD', true, platform, {
    version,
    detail: ok ? null : `需要 DSH ${DSH_VERSION_RANGE}`,
  });
}

function toolCheck(
  id: 'ffmpeg' | 'ffprobe',
  probe: ProbeResult,
  platform: NodeJS.Platform,
  detail: string | null = null,
): EnvironmentCheck {
  if (!probe.found) {
    return checkRow(id, id, '可执行', 'MISSING', true, platform, {
      detail: probe.detail ?? `${id} was not found`,
    });
  }
  return checkRow(id, id, '可执行', 'OK', true, platform, {
    version: probe.version,
    path: probe.path,
    detail: detail ?? probe.detail,
  });
}

async function dataDirCheck(
  dataDir: string,
  freeGb: (dir: string) => number | null,
  platform: NodeJS.Platform,
  minFreeGb: number,
): Promise<EnvironmentCheck> {
  const probeFile = join(dataDir, `.local-frames-write-check-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(probeFile, 'local-frames', { encoding: 'utf8', flag: 'wx' });
    await unlink(probeFile);
  } catch (error) {
    return checkRow('dataDir', '数据目录', '可写', 'MISSING', true, platform, {
      path: dataDir,
      detail: `数据目录不可写：${errorMessage(error)}`,
    });
  }
  const free = freeGb(dataDir);
  if (free === null) {
    return checkRow('dataDir', '数据目录', '可写', 'MISSING', true, platform, {
      path: dataDir,
      detail: '无法读取磁盘剩余空间',
    });
  }
  if (free < minFreeGb) {
    return checkRow('dataDir', '数据目录', `剩余 >= ${minFreeGb} GB`, 'MISSING', true, platform, {
      path: dataDir,
      detail: `剩余 ${free.toFixed(1)} GB，低于 ${minFreeGb} GB`,
    });
  }
  return checkRow('dataDir', '数据目录', `剩余 >= ${minFreeGb} GB`, 'OK', true, platform, {
    path: dataDir,
    version: `${free.toFixed(1)} GB 可用`,
    detail: null,
  });
}

/** Run the §15.1 checks; used at plugin start, by `lf_status` and by the settings page refresh. */
export async function checkEnvironment(deps: EnvironmentDeps): Promise<EnvironmentReport> {
  const platform = deps.platform ?? process.platform;
  const nodeVersion = (deps.nodeVersion ?? process.version).replace(/^v/, '');
  const npm = await probeCommand(deps.subprocess, deps.dataDir, 'npm', ['--version']);
  const ffmpeg = await probeCommand(deps.subprocess, deps.dataDir, 'ffmpeg', ['-version']);
  const ffprobe = await probeCommand(deps.subprocess, deps.dataDir, 'ffprobe', ['-version']);
  const git = await probeCommand(deps.subprocess, deps.dataDir, 'git', ['--version']);

  let ffprobeDetail: string | null = null;
  let ffprobeStatus: CheckStatus = 'OK';
  if (ffmpeg.found && ffprobe.found && ffmpeg.version !== null && ffprobe.version !== null && ffmpeg.version !== ffprobe.version) {
    ffprobeStatus = 'TOO_OLD';
    ffprobeDetail = `ffprobe 版本 ${ffprobe.version} 与 ffmpeg 版本 ${ffmpeg.version} 不一致`;
  }

  let ffmpegDetail: string | null = null;
  if (ffmpeg.found && ffmpeg.version !== null && !meetsMinimum(ffmpeg.version, FFMPEG_RECOMMENDED_VERSION)) {
    ffmpegDetail = `版本低于建议的 ${FFMPEG_RECOMMENDED_VERSION}，仍可运行`;
  }

  const ffprobeCheck: EnvironmentCheck =
    ffprobeStatus === 'OK'
      ? toolCheck('ffprobe', ffprobe, platform)
      : checkRow('ffprobe', 'ffprobe', '与 ffmpeg 版本一致', 'TOO_OLD', true, platform, {
          version: ffprobe.version,
          path: ffprobe.path,
          detail: ffprobeDetail,
        });

  const checks: EnvironmentCheck[] = [
    nodeCheck(nodeVersion, platform),
    npm.found
      ? checkRow('npm', 'npm', '可执行', 'OK', false, platform, { version: npm.version, path: npm.path, detail: npm.detail })
      : checkRow('npm', 'npm', '可执行', 'MISSING', false, platform, { detail: npm.detail ?? 'npm was not found' }),
    toolCheck('ffmpeg', ffmpeg, platform, ffmpegDetail),
    ffprobeCheck,
    dshCheck(deps.dshVersion === undefined ? null : deps.dshVersion, platform),
    git.found
      ? checkRow('git', 'Git', '可执行', 'OK', false, platform, { version: git.version, path: git.path, detail: git.detail })
      : checkRow('git', 'Git', '可执行', 'MISSING', false, platform, { detail: git.detail ?? 'git was not found' }),
    await dataDirCheck(deps.dataDir, deps.freeGb ?? freeDiskGb, platform, DEFAULT_MIN_FREE_DISK_GB),
  ];

  const missing = checks.filter((check) => check.status !== 'OK').map((check) => check.id);
  const ok = checks.every((check) => !check.blocking || check.status === 'OK');
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  return { ok, checks, missing, checkedAt };
}

/** Read DSH's own package version from the profile install anchor without spawning a process. */
export function readDshVersion(profileContext: unknown): string | null {
  if (typeof profileContext !== 'object' || profileContext === null) return null;
  const installAnchor = (profileContext as { installAnchor?: unknown }).installAnchor;
  if (typeof installAnchor !== 'string' || installAnchor.length === 0) return null;
  try {
    const parsed = JSON.parse(readFileSync(installAnchor, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as { name?: unknown; version?: unknown };
    if (record.name !== '@deepseek-ai/dsh') return null;
    return typeof record.version === 'string' && record.version.length > 0 ? record.version : null;
  } catch {
    return null;
  }
}

/** Cached environment report with an explicit refresh, shared by plugin start and the pages. */
export class EnvironmentChecker {
  private readonly deps: EnvironmentDeps;
  private report: EnvironmentReport | null = null;
  private inFlight: Promise<EnvironmentReport> | null = null;

  constructor(deps: EnvironmentDeps) {
    this.deps = deps;
  }

  get cached(): EnvironmentReport | null {
    return this.report;
  }

  async check(fresh = false): Promise<EnvironmentReport> {
    if (!fresh && this.report !== null) return this.report;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = checkEnvironment(this.deps).then(
      (report) => {
        this.report = report;
        this.inFlight = null;
        return report;
      },
      (error: unknown) => {
        this.inFlight = null;
        throw error;
      },
    );
    return this.inFlight;
  }
}

/** Home-derived default data directory; no drive letter is hardcoded. */
export function defaultDataDir(): string {
  return join(homedir(), 'local-frames-data');
}

/**
 * §15.1: Node below 22.13 or a DSH outside the supported range means the
 * plugin must not load; the caller reports the derived message.
 */
export function assertSupportedRuntime(nodeVersion: string, dshVersion: string | null): void {
  const node = nodeVersion.replace(/^v/, '');
  if (!meetsMinimum(node, NODE_MIN_VERSION)) {
    throw new Error(`local-frames requires Node.js >= ${NODE_MIN_VERSION} (found ${node}); upgrade Node and restart DSH`);
  }
  if (dshVersion !== null && !withinDshRange(dshVersion)) {
    throw new Error(`local-frames requires DSH ${DSH_VERSION_RANGE} (found ${dshVersion}); upgrade DSH`);
  }
}
