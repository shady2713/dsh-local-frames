import { classifyFailure, visionSessionId, type VisionClient, type VisionResult } from './vision.js';
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
/** §7.5: one model call is aborted after this long and treated as retryable. */
export const VISION_CALL_TIMEOUT_MS = 120_000;
/** §7.5: total attempts for one frame, including the first call. */
export const MAX_ATTEMPTS_PER_FRAME = 5;
const TRANSPORT_WAITS_MS = [1000, 5000, 10_000, 30_000];

function attemptFrom(result: VisionResult, error: string | null, ok: boolean): JudgeAttempt {
  return {
    ok,
    ms: result.ok ? result.ms : 0,
    tokens: result.ok ? result.tokens : null,
    error,
  };
}

/**
 * One frame: one call containing every object, with bounded retries.
 * A missing-credential error after this process started waits 3 seconds and is
 * tried once more. Invalid credentials and an exhausted quota do not retry.
 * Timeouts and other retryable failures are retried until the frame has made
 * `maxAttempts` calls in total, including the first one.
 */
export async function judgeBatch(options: {
  vision: VisionClient;
  provider: string;
  model: string;
  objects: readonly PromptObject[];
  imagePath: string;
  taskId: string;
  sleep: (ms: number) => Promise<void>;
  beforeCall: () => void;
  onAttempt: (attempt: JudgeAttempt) => void;
  credentialRetry: { used: boolean };
  timeoutMs?: number;
  maxAttempts?: number;
}): Promise<JudgeBatch> {
  const names = options.objects.map((object) => object.name);
  const prompt = buildPrompt(options.objects);
  const attempts: JudgeAttempt[] = [];
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? MAX_ATTEMPTS_PER_FRAME));
  const timeoutMs = options.timeoutMs ?? VISION_CALL_TIMEOUT_MS;
  let attemptsUsed = 0;
  let formatWaits = 0;
  let transportWaits = 0;
  let missingCredentialRetried = false;

  const callOnce = async (): Promise<{ result: VisionResult; ms: number }> => {
    options.beforeCall();
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<VisionResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, kind: 'retryable', message: `模型调用超时（${timeoutMs} ms）` });
      }, timeoutMs);
    });
    const call = options.vision
      .judge({
        provider: options.provider,
        model: options.model,
        prompt,
        imagePath: options.imagePath,
        sessionId: visionSessionId(options.taskId),
        signal: controller.signal,
      })
      .catch((error: unknown): VisionResult => {
        const message = error instanceof Error ? error.message : String(error);
        const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
        const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : undefined;
        return classifyFailure({ code, message, ...(status === undefined ? {} : { status }) });
      });
    try {
      const result = await Promise.race([call, timedOut]);
      return { result, ms: Date.now() - started };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const record = (result: VisionResult, ms: number, error: string | null, ok: boolean): void => {
    const attempt = attemptFrom(result, error, ok);
    attempt.ms = result.ok && result.ms > 0 ? result.ms : ms;
    attempts.push(attempt);
    options.onAttempt(attempt);
  };

  for (;;) {
    if (attemptsUsed >= maxAttempts) {
      return { ok: false, reason: 'call', message: `模型调用尝试次数已用尽（${maxAttempts} 次）`, attempts };
    }
    attemptsUsed += 1;
    const { result, ms } = await callOnce();
    if (!result.ok && result.kind === 'credential_missing' && !options.credentialRetry.used && !missingCredentialRetried) {
      record(result, ms, result.message, false);
      options.credentialRetry.used = true;
      missingCredentialRetried = true;
      if (attemptsUsed >= maxAttempts) {
        return { ok: false, reason: 'call', message: result.message, attempts };
      }
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
      if (attemptsUsed >= maxAttempts) {
        return { ok: false, reason: 'call', message: result.message, attempts };
      }
      const wait = result.retryAfterMs ?? TRANSPORT_WAITS_MS[Math.min(transportWaits, TRANSPORT_WAITS_MS.length - 1)] ?? 5000;
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
    if (attemptsUsed >= maxAttempts || formatWaits >= 2) {
      return { ok: false, reason: 'format', message: parsed.message, attempts };
    }
    const wait = FORMAT_WAITS_MS[formatWaits] ?? 5000;
    formatWaits += 1;
    await options.sleep(wait);
  }
}
