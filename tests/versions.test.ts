import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSupportedRuntime,
  checkEnvironment,
  compareVersions,
  EnvironmentChecker,
  meetsMinimum,
  parseSemver,
  parseVersionOutput,
  readDshVersion,
  withinDshRange,
} from '../src/versions.js';
import { fakeSubprocess, healthySubprocess, makeTempDir } from './helpers.js';

describe('version comparison', () => {
  it('compares releases and prereleases', () => {
    expect(compareVersions('24.22.1', '22.13.0')).toBe(1);
    expect(compareVersions('22.13.0', '22.13.0')).toBe(0);
    expect(compareVersions('22.12.9', '22.13.0')).toBe(-1);
    expect(compareVersions('0.2.1-rc.5', '0.2.1-rc.2')).toBe(1);
    expect(compareVersions('0.2.1-rc.10', '0.2.1-rc.9')).toBe(1);
    expect(compareVersions('0.2.1', '0.2.1-rc.5')).toBe(1);
    expect(compareVersions('nonsense', '1.0.0')).toBeNull();
    expect(parseSemver('v1.2.3-beta.1+build')).toEqual({ core: [1, 2, 3], prerelease: ['beta', '1'] });
  });

  it('applies the Node and DSH boundaries', () => {
    expect(meetsMinimum('22.13.0', '22.13.0')).toBe(true);
    expect(meetsMinimum('22.12.0', '22.13.0')).toBe(false);
    expect(withinDshRange('0.2.1-rc.2')).toBe(true);
    expect(withinDshRange('0.2.1-rc.5')).toBe(true);
    expect(withinDshRange('0.2.1-rc.1')).toBe(false);
    expect(withinDshRange('0.3.0')).toBe(false);
    expect(withinDshRange('0.2.0')).toBe(false);
  });

  it('parses command version output', () => {
    expect(parseVersionOutput('ffmpeg version 7.1.5-0+deb13u1 Copyright')).toBe('7.1.5-0+deb13u1');
    expect(parseVersionOutput('v24.22.1\n')).toBe('24.22.1');
    expect(parseVersionOutput('git version 2.47.3\n')).toBe('2.47.3');
    expect(parseVersionOutput('')).toBeNull();
  });
});

describe('environment check (§15.1)', () => {
  it('reports every resource OK with a writable data directory and enough disk', async () => {
    const dataDir = makeTempDir();
    const report = await checkEnvironment({
      subprocess: healthySubprocess(),
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 100,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.checks.map((check) => check.id)).toEqual(['node', 'npm', 'ffmpeg', 'ffprobe', 'dsh', 'git', 'dataDir']);
    expect(report.checkedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.checks.every((check) => check.status === 'OK')).toBe(true);
  });

  it('marks Node below 22.13 as TOO_OLD and blocks tasks', async () => {
    const dataDir = makeTempDir();
    const report = await checkEnvironment({
      subprocess: healthySubprocess(),
      dataDir,
      nodeVersion: '22.12.0',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 100,
    });
    const node = report.checks.find((check) => check.id === 'node');
    expect(node?.status).toBe('TOO_OLD');
    expect(node?.blocking).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('node');
  });

  it('marks a missing ffmpeg as MISSING and blocks tasks', async () => {
    const dataDir = makeTempDir();
    const subprocess = fakeSubprocess({
      npm: { path: '/usr/bin/npm', output: '11.21.1\n' },
      ffprobe: { path: '/usr/bin/ffprobe', output: 'ffprobe version 7.1.5\n' },
      git: { path: '/usr/bin/git', output: 'git version 2.47.3\n' },
    });
    const report = await checkEnvironment({
      subprocess,
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 100,
    });
    const ffmpeg = report.checks.find((check) => check.id === 'ffmpeg');
    expect(ffmpeg?.status).toBe('MISSING');
    expect(ffmpeg?.install).toContain('ffmpeg');
    expect(report.ok).toBe(false);
  });

  it('marks a missing ffprobe as MISSING and blocks tasks', async () => {
    const dataDir = makeTempDir();
    const subprocess = fakeSubprocess({
      npm: { path: '/usr/bin/npm', output: '11.21.1\n' },
      ffmpeg: { path: '/usr/bin/ffmpeg', output: 'ffmpeg version 7.1.5\n' },
      git: { path: '/usr/bin/git', output: 'git version 2.47.3\n' },
    });
    const report = await checkEnvironment({
      subprocess,
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 100,
    });
    expect(report.checks.find((check) => check.id === 'ffprobe')?.status).toBe('MISSING');
    expect(report.ok).toBe(false);
  });

  it('refuses an ffmpeg/ffprobe version mismatch', async () => {
    const dataDir = makeTempDir();
    const subprocess = fakeSubprocess({
      npm: { path: '/usr/bin/npm', output: '11.21.1\n' },
      ffmpeg: { path: '/usr/bin/ffmpeg', output: 'ffmpeg version 7.1.5\n' },
      ffprobe: { path: '/usr/bin/ffprobe', output: 'ffprobe version 6.1.0\n' },
      git: { path: '/usr/bin/git', output: 'git version 2.47.3\n' },
    });
    const report = await checkEnvironment({
      subprocess,
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 100,
    });
    const ffprobe = report.checks.find((check) => check.id === 'ffprobe');
    expect(ffprobe?.status).toBe('TOO_OLD');
    expect(ffprobe?.detail).toContain('不一致');
    expect(report.ok).toBe(false);
  });

  it('marks an out-of-range DSH as TOO_OLD and an unreadable version as MISSING', async () => {
    const dataDir = makeTempDir();
    const old = await checkEnvironment({
      subprocess: healthySubprocess(),
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.3.0',
      freeGb: () => 100,
    });
    expect(old.checks.find((check) => check.id === 'dsh')?.status).toBe('TOO_OLD');
    const unknown = await checkEnvironment({
      subprocess: healthySubprocess(),
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: null,
      freeGb: () => 100,
    });
    expect(unknown.checks.find((check) => check.id === 'dsh')?.status).toBe('MISSING');
  });

  it('keeps a missing npm or Git non-blocking but reports it', async () => {
    const dataDir = makeTempDir();
    const report = await checkEnvironment({
      subprocess: fakeSubprocess({
        ffmpeg: { path: '/usr/bin/ffmpeg', output: 'ffmpeg version 7.1.5\n' },
        ffprobe: { path: '/usr/bin/ffprobe', output: 'ffprobe version 7.1.5\n' },
      }),
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 100,
    });
    expect(report.missing).toEqual(expect.arrayContaining(['npm', 'git']));
    expect(report.ok).toBe(true);
  });

  it('blocks tasks when the data directory has too little free space', async () => {
    const dataDir = makeTempDir();
    const report = await checkEnvironment({
      subprocess: healthySubprocess(),
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 5,
    });
    const dataDirCheck = report.checks.find((check) => check.id === 'dataDir');
    expect(dataDirCheck?.status).toBe('MISSING');
    expect(dataDirCheck?.detail).toContain('10 GB');
    expect(report.ok).toBe(false);
  });

  it('caches the report and refreshes only when asked', async () => {
    const dataDir = makeTempDir();
    const subprocess = healthySubprocess();
    const checker = new EnvironmentChecker({
      subprocess,
      dataDir,
      nodeVersion: '24.22.1',
      dshVersion: '0.2.1-rc.5',
      freeGb: () => 100,
    });
    const first = await checker.check();
    const spawnsAfterFirst = subprocess.spawns.length;
    expect(await checker.check()).toBe(first);
    expect(subprocess.spawns.length).toBe(spawnsAfterFirst);
    await checker.check(true);
    expect(subprocess.spawns.length).toBeGreaterThan(spawnsAfterFirst);
  });
});

describe('DSH version discovery', () => {
  it('reads the version from the profile install anchor', () => {
    const dir = makeTempDir();
    const anchor = join(dir, 'package.json');
    writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' }));
    expect(readDshVersion({ installAnchor: anchor })).toBe('0.2.1-rc.5');
  });

  it('returns null for a missing or unrelated anchor', () => {
    const dir = makeTempDir();
    const anchor = join(dir, 'package.json');
    writeFileSync(anchor, JSON.stringify({ name: 'other', version: '1.0.0' }));
    expect(readDshVersion({ installAnchor: anchor })).toBeNull();
    expect(readDshVersion({ installAnchor: join(dir, 'missing.json') })).toBeNull();
    expect(readDshVersion(null)).toBeNull();
  });
});

describe('load-time runtime gate (§15.1)', () => {
  it('refuses to load on Node below 22.13', () => {
    expect(() => assertSupportedRuntime('22.12.0', '0.2.1-rc.5')).toThrow(/Node\.js >= 22\.13/);
    expect(() => assertSupportedRuntime('v22.13.0', '0.2.1-rc.5')).not.toThrow();
  });

  it('refuses to load outside the supported DSH range, but allows an unknown version', () => {
    expect(() => assertSupportedRuntime('24.22.1', '0.3.0')).toThrow(/DSH/);
    expect(() => assertSupportedRuntime('24.22.1', '0.2.1-rc.1')).toThrow(/DSH/);
    expect(() => assertSupportedRuntime('24.22.1', '0.2.1-rc.5')).not.toThrow();
    expect(() => assertSupportedRuntime('24.22.1', null)).not.toThrow();
  });
});
