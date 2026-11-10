import type { VisionClient, VisionResult } from './vision.js';
import { buildPrompt, parseModelOutput, type ModelObject, type PromptObject } from './prompt.js';

export class TaskPause extends Error {
  readonly code: string;
  readonly gap: Record<string, unknown> | null;

  constructor(code: string, message: string, gap: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'TaskPause';
    this.code = code;
    this.gap = gap;
  }
}

/** The task is no longer RUNNING. This is not a failure and not a pause. */
export class TaskStopped extends Error {
  constructor() {
    super('任务已停止');
    this.name = 'TaskStopped';
  }
}

export interface JudgeAttempt {
  ok: boolean;
  ms: number;
  tokens: number | null;
  error: string | null;
}

export type JudgeBatch =
  | { ok: true; objects: ModelObject[]; attempts: JudgeAttempt[] }
  | { ok: false; reason: 'format' | 'call'; message: string; attempts: JudgeAttempt[] };

const FORMAT_WAITS_MS = [1000, 5000];

function attemptFrom(result: VisionResult, error: string | null, ok: boolean): JudgeAttempt {
  return {
    ok,
    ms: result.ok ? result.ms : 0,
    tokens: result.ok ? result.tokens : null,
    error,
  };
}

/**
 * One batch: the initial call plus at most two retries.
 * The first "missing credential" error after this process started waits 3 seconds
 * and is tried once more. Invalid credentials and an exhausted quota do not retry.
 */
export async function judgeBatch(options: {
  vision: VisionClient;
  provider: string;
  model: string;
  objects: readonly PromptObject[];
  imagePath: string;
  sleep: (ms: number) => Promise<void>;
  beforeCall: () => void;
  onAttempt: (attempt: JudgeAttempt) => void;
  credentialRetry: { used: boolean };
  signal?: AbortSignal;
}): Promise<JudgeBatch> {
  const names = options.objects.map((object) => object.name);
  const prompt = buildPrompt(options.objects);
  const attempts: JudgeAttempt[] = [];
  let formatWaits = 0;
  let transportWaits = 0;
  let missingCredentialRetried = false;

  const callOnce = async (): Promise<{ result: VisionResult; ms: number }> => {
    options.beforeCall();
    const started = Date.now();
    const result = await options.vision.judge({
      provider: options.provider,
      model: options.model,
      prompt,
      imagePath: options.imagePath,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { result, ms: Date.now() - started };
  };

  const record = (result: VisionResult, ms: number, error: string | null, ok: boolean): void => {
    const attempt = attemptFrom(result, error, ok);
    attempt.ms = result.ok && result.ms > 0 ? result.ms : ms;
    attempts.push(attempt);
    options.onAttempt(attempt);
  };

  for (;;) {
    const { result, ms } = await callOnce();
    if (!result.ok && result.kind === 'credential_missing' && !options.credentialRetry.used && !missingCredentialRetried) {
      record(result, ms, result.message, false);
      options.credentialRetry.used = true;
      missingCredentialRetried = true;
      await options.sleep(3000);
      continue;
    }
    if (!result.ok && (result.kind === 'credential_invalid' || result.kind === 'credential_missing')) {
      record(result, ms, result.message, false);
      throw new TaskPause('MODEL_CREDENTIAL', result.message);
    }
    if (!result.ok && result.kind === 'quota') {
      record(result, ms, result.message, false);
      throw new TaskPause('MODEL_QUOTA', result.message);
    }
    if (!result.ok && result.kind === 'unavailable') {
      record(result, ms, result.message, false);
      throw new TaskPause('NO_LLM', result.message);
    }
    if (!result.ok) {
      record(result, ms, result.message, false);
      if (transportWaits >= 2) return { ok: false, reason: 'call', message: result.message, attempts };
      const wait = result.retryAfterMs ?? FORMAT_WAITS_MS[transportWaits] ?? 5000;
      transportWaits += 1;
      await options.sleep(wait);
      continue;
    }
    const parsed = parseModelOutput(result.text, names);
    if (parsed.ok) {
      record(result, ms, null, true);
      return { ok: true, objects: parsed.objects, attempts };
    }
    record(result, ms, parsed.message, false);
    if (formatWaits >= 2) return { ok: false, reason: 'format', message: parsed.message, attempts };
    const wait = FORMAT_WAITS_MS[formatWaits] ?? 5000;
    formatWaits += 1;
    await options.sleep(wait);
  }
}
