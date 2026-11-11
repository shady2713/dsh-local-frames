import { homedir } from 'node:os';
import { join } from 'node:path';

export type TargetAliases = Record<string, string[]>;

/** The single model slot. Credentials live in DSH, never in this plugin. */
export interface ModelChoice {
  provider: string;
  model: string;
}

/** User-editable settings stored in the plugin's own `settings` table. No secrets. */
export interface Settings {
  model: ModelChoice | null;
  dataDirLimitGb: number;
  budgetPerTask: number;
  frameIntervalSeconds: number;
  /** Absolute export directory; null means the default `<dataDir>/exports`. */
  exportDir: string | null;
  /** Last absolute path submitted on the progress page; refilled when it reopens. */
  lastImportPath: string | null;
  allowRoots: string[];
}

export type TaskStatus = 'RUNNING' | 'PAUSED' | 'DONE' | 'CANCELLED';
export type ItemState = 'NEW' | 'PROBED' | 'FRAMED' | 'DONE' | 'ERROR';
export type FrameState = 'PENDING' | 'JUDGED' | 'FAILED' | 'DUPLICATE';
export type Verdict = 'PRESENT' | 'ABSENT' | 'UNSURE';
export type Visibility = 'CLEAR' | 'SMALL' | 'TINY' | 'OCCLUDED';
export type Outcome = 'QUALIFIED' | 'UNSURE' | 'NOT_QUALIFIED';

export interface TargetRow {
  target_id: string;
  name: string;
  aliases_json: string;
  definition: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  task_id: string;
  spec_json: string;
  progress_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ToolResult {
  status: 'OK' | 'ERROR';
  message: string;
  data: Record<string, unknown>;
}

export type CheckStatus = 'OK' | 'MISSING' | 'TOO_OLD';
export type EnvironmentCheckId = 'node' | 'npm' | 'ffmpeg' | 'ffprobe' | 'dsh' | 'git' | 'dataDir';

/** One row of the environment panel and the `environment` field of `lf_status`. */
export interface EnvironmentCheck {
  id: EnvironmentCheckId;
  label: string;
  required: string;
  status: CheckStatus;
  version: string | null;
  path: string | null;
  /** Whether a failing check blocks starting a new task. */
  blocking: boolean;
  detail: string | null;
  install: string | null;
}

export interface EnvironmentReport {
  ok: boolean;
  checks: EnvironmentCheck[];
  missing: EnvironmentCheckId[];
  checkedAt: string;
}

export interface StatusSnapshot {
  plugin: { id: string; version: string };
  settings: Settings;
  targets: Array<{
    target_id: string;
    name: string;
    aliases: TargetAliases;
    definition: string;
    archived: boolean;
  }>;
  task: {
    task_id: string;
    status: string;
    progress: Record<string, unknown>;
  } | null;
  funnel: {
    imported: number;
    probed: number;
    frames: number;
    duplicatesSkipped: number;
    judged: number;
    exportable: number;
    errors: number;
  };
  errors: Array<{ item_id: string; local_path: string; error_code: string | null }>;
  pause: { code: string | null; reason: string | null } | null;
  dataDir: {
    path: string;
    usedBytes: number;
    limitGb: number;
    freeGb: number | null;
  };
  environment: EnvironmentReport;
}
