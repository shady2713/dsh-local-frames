import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ExportRequestBody {
  zip: boolean;
  byObject: boolean;
  taskId?: string;
  targetIds?: string[];
  match?: 'any' | 'all';
  exportDir?: string;
}

type ExportPlan =
  | { ok: true; body: ExportRequestBody }
  | { ok: false; reason: 'exportDir' | 'allTargets'; message: string };

interface PlannerInput {
  taskId?: string | null;
  targetIds?: string[];
  rowTaskId?: string;
  cardTaskId?: string | null;
  selectedTargets?: string[];
  match?: 'any' | 'all';
  exportRunDir?: string;
  zip?: boolean;
  byObject?: boolean;
}

interface ClientExportHelpers {
  buildExportRequest(input: PlannerInput & { exportDir?: string; allTargetsMessage?: string }): ExportPlan;
  planCardExport(input: PlannerInput): ExportPlan;
  planRowExport(input: PlannerInput): ExportPlan;
}

/**
 * client.js is a classic script, so load it the same way the browser does and
 * return the top-level pure planners the UI itself calls.
 */
function loadClientExportHelpers(): ClientExportHelpers {
  const source = readFileSync(join(process.cwd(), 'client.js'), 'utf8');
  const fakeWindow = { __ModuleLoader__: { load: () => undefined } };
  const fakeDocument = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => undefined },
  };
  const load = new Function('window', 'document', `${source}\nreturn lfExportRequestHelpers();`);
  return load(fakeWindow, fakeDocument) as ClientExportHelpers;
}

const helpers = loadClientExportHelpers();

function bodyOf(plan: ExportPlan): ExportRequestBody {
  if (!plan.ok) throw new Error(`expected an export plan, got ${plan.reason}: ${plan.message}`);
  return plan.body;
}

describe('issue #28 row export follows the export card', () => {
  it('keeps the checked objects when the row is the card task and match is all', () => {
    const plan = helpers.planRowExport({
      rowTaskId: 'task-1',
      cardTaskId: 'task-1',
      selectedTargets: ['target-a', 'target-b'],
      match: 'all',
      exportRunDir: '/tmp/export-runs/one',
      zip: true,
      byObject: false,
    });
    expect(bodyOf(plan)).toEqual({
      zip: true,
      byObject: false,
      taskId: 'task-1',
      targetIds: ['target-a', 'target-b'],
      match: 'all',
      exportDir: '/tmp/export-runs/one',
    });
  });

  it('never carries another task checkboxes and keeps match any for all objects', () => {
    const plan = helpers.planRowExport({
      rowTaskId: 'task-2',
      cardTaskId: 'task-1',
      selectedTargets: ['target-a', 'target-b'],
      match: 'any',
      exportRunDir: '/tmp/export-runs/two',
      zip: false,
      byObject: true,
    });
    const body = bodyOf(plan);
    expect(body).toMatchObject({
      zip: false,
      byObject: true,
      taskId: 'task-2',
      match: 'any',
      exportDir: '/tmp/export-runs/two',
    });
    expect(body).not.toHaveProperty('targetIds');
  });

  it('rejects all with match all when the row is not the card task', () => {
    const plan = helpers.planRowExport({
      rowTaskId: 'task-2',
      cardTaskId: 'task-1',
      selectedTargets: ['target-a'],
      match: 'all',
      exportRunDir: '',
      zip: false,
      byObject: false,
    });
    expect(plan).toEqual({
      ok: false,
      reason: 'allTargets',
      message: '全部命中需要至少勾选一个对象，请在导出卡片勾选后再导出',
    });
  });

  it('rejects all with match all when the card task has no checked object', () => {
    const plan = helpers.planRowExport({
      rowTaskId: 'task-1',
      cardTaskId: 'task-1',
      selectedTargets: [],
      match: 'all',
      exportRunDir: '/tmp/export-runs/one',
      zip: false,
      byObject: false,
    });
    expect(plan).toEqual({
      ok: false,
      reason: 'allTargets',
      message: '全部命中需要至少勾选一个对象，请在导出卡片勾选后再导出',
    });
  });

  it('rejects a relative per-export directory before sending anything', () => {
    const plan = helpers.planRowExport({
      rowTaskId: 'task-1',
      cardTaskId: 'task-1',
      selectedTargets: ['target-a'],
      match: 'any',
      exportRunDir: 'relative/exports',
      zip: false,
      byObject: false,
    });
    expect(plan).toEqual({
      ok: false,
      reason: 'exportDir',
      message: '本次导出目录必须是绝对路径：relative/exports',
    });
  });

  it('omits a blank per-export directory so the saved setting is used', () => {
    const plan = helpers.planRowExport({
      rowTaskId: 'task-1',
      cardTaskId: 'task-1',
      selectedTargets: ['target-a'],
      match: 'any',
      exportRunDir: '   ',
      zip: false,
      byObject: false,
    });
    const body = bodyOf(plan);
    expect(body).not.toHaveProperty('exportDir');
    expect(body).toMatchObject({ taskId: 'task-1', targetIds: ['target-a'], match: 'any' });
  });

  it('passes zip and byObject through from the card switches', () => {
    const body = bodyOf(
      helpers.planRowExport({
        rowTaskId: 'task-1',
        cardTaskId: 'task-1',
        selectedTargets: [],
        match: 'any',
        exportRunDir: '',
        zip: true,
        byObject: true,
      }),
    );
    expect(body).toMatchObject({ zip: true, byObject: true });
    expect(body).not.toHaveProperty('targetIds');
  });

  it('uses the edited directory verbatim after trimming and drops empty target ids', () => {
    const body = bodyOf(
      helpers.buildExportRequest({
        taskId: 'task-1',
        targetIds: ['target-a', '', 'target-b'],
        match: 'all',
        exportDir: '  /tmp/export-runs/trimmed  ',
        zip: false,
        byObject: false,
      }),
    );
    expect(body).toEqual({
      zip: false,
      byObject: false,
      taskId: 'task-1',
      targetIds: ['target-a', 'target-b'],
      match: 'all',
      exportDir: '/tmp/export-runs/trimmed',
    });
  });
});

describe('issue #28 card export keeps its existing behavior', () => {
  it('shares the directory and target validation with the row export', () => {
    const relative = helpers.planCardExport({
      taskId: 'task-1',
      selectedTargets: ['target-a'],
      match: 'any',
      exportRunDir: 'relative/exports',
      zip: false,
      byObject: false,
    });
    expect(relative).toEqual({
      ok: false,
      reason: 'exportDir',
      message: '本次导出目录必须是绝对路径：relative/exports',
    });

    const missingTargets = helpers.planCardExport({
      taskId: 'task-1',
      selectedTargets: [],
      match: 'all',
      exportRunDir: '/tmp/export-runs/one',
      zip: false,
      byObject: false,
    });
    expect(missingTargets).toEqual({
      ok: false,
      reason: 'allTargets',
      message: '全部命中需要至少勾选一个对象',
    });
  });

  it('builds the same body shape as before for the card button', () => {
    const body = bodyOf(
      helpers.planCardExport({
        taskId: 'task-1',
        selectedTargets: ['target-a'],
        match: 'any',
        exportRunDir: '/tmp/export-runs/one',
        zip: true,
        byObject: false,
      }),
    );
    expect(body).toEqual({
      zip: true,
      byObject: false,
      taskId: 'task-1',
      targetIds: ['target-a'],
      match: 'any',
      exportDir: '/tmp/export-runs/one',
    });
  });
});
