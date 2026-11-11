import { homedir } from 'node:os';
import { join } from 'node:path';

export type TargetAliases = Record<string, string[]>;

/** The single model slot. Credentials live in DSH, never in this plugin. */
export interface ModelChoice {
  provider: string;
  model: string;
}

/** One completed export, newest first in {@link Settings.recentExports}. */
export interface RecentExport {
  /** UTC ISO timestamp of the export. */
  exported_at: string;
  task_id: string;
  target_ids: string[];
  target_names: string[];
  images: number;
  train: number;
  val: number;
  /** Export directory, or the zip file path when `zip` is true. */
  directory: string;
  zip: boolean;
}

/** User-editable settings stored in the plugin's own `settings` table. No secrets. */
export interface Settings {
  model: ModelChoice | null;
  dataDirLimitGb: number;
  budgetPerTask: number;
  frameIntervalSeconds: number;
  /** Number of frames labelled in parallel; 1 means one model call at a time. */
  visionConcurrency: number;
  /** Absolute export directory; null means the default `<dataDir>/exports`. */
  exportDir: string | null;
  /** Last absolute path submitted on the progress page; refilled when it reopens. */
  lastImportPath: string | null;
  allowRoots: string[];
  /** Most recent successful exports, newest first; capped and derived, not user input. */
  recentExports: RecentExport[];
}

export type TaskStatus = 'RUNNING' | 'PAUSED' | 'DONE' | 'CANCELLED';
export type ItemState = 'NEW' | 'PROBED' | 'FRAMED' | 'DONE' | 'ERROR' | 'SKIPPED';
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

/** One imported video in task order; `position` starts at 1 and is the processing order. */
export interface FunnelStats {
  imported: number;
  probed: number;
  frames: number;
  duplicatesSkipped: number;
  skipped: number;
  judged: number;
  exportable: number;
  errors: number;
}

/** One object selected for a task, as shown in the task list and export selection. */
export interface TaskTargetRef {
  target_id: string;
  name: string;
}

/** One row of `GET /api/local-frames/tasks`; read-only task history. */
export interface TaskSummary {
  task_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  funnel: FunnelStats;
  /** Frames in the FAILED state that can be retried individually. */
  failedFrames: number;
  targets: TaskTargetRef[];
}

/** One failed frame shown in the progress area for manual retry. */
export interface StatusFailedFrame {
  frame_id: string;
  item_id: string;
  local_path: string;
  title: string;
  t_ms: number;
  error: string | null;
}

/** Result of `POST /api/local-frames/retry`. */
export interface RetryResult {
  task_id: string;
  task_status: string;
  items_retried: string[];
  frames_retried: string[];
  skipped: Array<{ id: string; kind: 'item' | 'frame'; reason: string }>;
}

export interface StatusItem {
  position: number;
  item_id: string;
  local_path: string;
  title: string;
  state: string;
  error_code: string | null;
  /** True when a previous task already framed and labelled these exact bytes. */
  skipped: boolean;
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
    /** Objects selected when the task was created; the export page lists these. */
    target_ids: string[];
  } | null;
  funnel: FunnelStats;
  items: StatusItem[];
  errors: Array<{ item_id: string; local_path: string; error_code: string | null }>;
  failedFrames: StatusFailedFrame[];
  pause: { code: string | null; reason: string | null } | null;
  dataDir: {
    path: string;
    usedBytes: number;
    limitGb: number;
    freeGb: number | null;
  };
  environment: EnvironmentReport;
}
