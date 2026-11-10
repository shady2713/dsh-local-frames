import { readFileSync } from 'node:fs';
import { exceedsAttachmentLimits, fitAttachmentBox, selectRequestImage, type ImageRequestTarget } from './imageFit.js';
import type { MediaClient } from './media.js';
import { readJpegInfo } from './media.js';

export type VisionKind = 'credential_missing' | 'credential_invalid' | 'quota' | 'retryable' | 'unavailable';

export type VisionResult =
  | { ok: true; text: string; tokens: number | null; ms: number }
  | { ok: false; kind: VisionKind; message: string; retryAfterMs?: number };

export interface VisionRequest {
  provider: string;
  model: string;
  prompt: string;
  imagePath: string;
  signal?: AbortSignal;
}

export interface VisionClient {
  available(): boolean;
  listImageModels(): Promise<Array<{ provider: string; model: string; name: string }>>;
  judge(input: VisionRequest): Promise<VisionResult>;
}

export interface ModelChunk {
  type: string;
  text?: string;
  block?: { type?: string; text?: string };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  reason?: {
    kind?: string;
    failure?: { code?: string; message?: string; status?: number; providerRetryAfterMs?: number };
  };
}

interface FoldState {
  text: string;
  tokens: number | null;
  failure: { code: string; message: string; status?: number; providerRetryAfterMs?: number } | null;
}

export function createStreamFold(): { push(chunk: ModelChunk): void; result(): VisionResult } {
  const state: FoldState = { text: '', tokens: null, failure: null };
  return {
    push(chunk) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') state.text += chunk.text;
      if (chunk.type === 'block-end' && state.text.length === 0 && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        state.text = chunk.block.text;
      }
      if (chunk.type === 'usage' && chunk.usage !== undefined) {
        const usage = chunk.usage;
        state.tokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      }
      if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        const failure = chunk.reason.failure;
        state.failure = {
          code: typeof failure?.code === 'string' ? failure.code : chunk.reason.kind,
          message: typeof failure?.message === 'string' ? failure.message : '模型调用失败',
          ...(typeof failure?.status === 'number' ? { status: failure.status } : {}),
          ...(typeof failure?.providerRetryAfterMs === 'number' ? { providerRetryAfterMs: failure.providerRetryAfterMs } : {}),
        };
      }
    },
    result() {
      if (state.failure !== null) return classifyFailure(state.failure);
      if (state.text.trim().length === 0) {
        return { ok: false, kind: 'retryable', message: '模型返回空响应' };
      }
      return { ok: true, text: state.text, tokens: state.tokens, ms: 0 };
    },
  };
}

export function classifyFailure(failure: {
  code?: string;
  message?: string;
  status?: number;
  providerRetryAfterMs?: number;
}): VisionResult {
  const code = (failure.code ?? '').toUpperCase();
  const message = failure.message ?? '模型调用失败';
  const blob = `${code} ${message}`.toLowerCase();
  const retryAfterMs = failure.providerRetryAfterMs;
  const withRetry = (kind: VisionKind): VisionResult =>
    retryAfterMs === undefined ? { ok: false, kind, message } : { ok: false, kind, message, retryAfterMs };
  if (/quota|insufficient_quota|billing|payment|额度/.test(blob)) return withRetry('quota');
  const missing = /missing|not set|blank|empty|未配置|缺凭据|没有凭据|no_api_key|no_credential/.test(blob);
  if (missing || code === 'NO_CREDENTIAL' || code === 'MISSING_CREDENTIAL') return withRetry('credential_missing');
  if (
    code === 'AUTH' ||
    code === 'UNAUTHORIZED' ||
    code === 'INVALID_CREDENTIAL' ||
    /invalid_credential|invalid api key|unauthorized|凭据无效|api key/.test(blob) ||
    failure.status === 401 ||
    failure.status === 403
  ) {
    return withRetry('credential_invalid');
  }
  return withRetry('retryable');
}

export interface ImageRef {
  attachmentId: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

export interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: 'image/jpeg'; name?: string }): Promise<ImageRef>;
  readImageRequest(
    ref: ImageRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; width: number; height: number; withinMaxBytes?: boolean; data?: Uint8Array }>;
}

export interface LlmStreamLike {
  imageRequestTarget(provider: string, model: string, image: ImageRef): ImageRequestTarget;
  prepareCall(
    config: { provider: string; model: string },
    signal?: AbortSignal,
  ): Promise<{ stream(options: Record<string, unknown>): AsyncIterable<ModelChunk> }>;
  listProviders?(): Promise<Array<{ id: string; name?: string }>> | Array<{ id: string; name?: string }>;
  listModels?(provider: string): Promise<Array<{ id: string; name?: string; inputModalities?: readonly string[] }>>;
}

async function shrinkToAttachmentLimit(media: MediaClient, imagePath: string, tmpDir: string): Promise<string> {
  let current = imagePath;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const info = readJpegInfo(current);
    if (info === null) return current;
    if (!exceedsAttachmentLimits(info.width, info.height, info.bytes)) return current;
    const box = fitAttachmentBox(info.width, info.height, info.bytes);
    const dest = `${tmpDir}/shrink-${attempt}.jpg`;
    const shrunk = await media.shrinkJpeg(current, dest, box.width, box.height);
    if (!shrunk.ok) return current;
    current = dest;
  }
  return current;
}

export function createHostVision(options: {
  llm: () => LlmStreamLike | null;
  attachments: () => AttachmentStoreLike | null;
  media: MediaClient;
  tmpDir: string;
}): VisionClient {
  return {
    available() {
      return options.llm() !== null && options.attachments() !== null;
    },
    async listImageModels() {
      const llm = options.llm();
      if (llm?.listProviders === undefined || llm.listModels === undefined) return [];
      const providers = await llm.listProviders();
      const models: Array<{ provider: string; model: string; name: string }> = [];
      for (const provider of providers) {
        let listed: Array<{ id: string; name?: string; inputModalities?: readonly string[] }> = [];
        try {
          listed = await llm.listModels(provider.id);
        } catch {
          continue;
        }
        for (const model of listed) {
          const modalities = model.inputModalities;
          if (modalities !== undefined && !modalities.includes('image')) continue;
          models.push({
            provider: provider.id,
            model: model.id,
            name: model.name ?? model.id,
          });
        }
      }
      return models;
    },
    async judge(input) {
      const llm = options.llm();
      const attachments = options.attachments();
      if (llm === null || attachments === null) {
        return { ok: false, kind: 'unavailable', message: '模型运行时不可用' };
      }
      const started = Date.now();
      try {
        const path = await shrinkToAttachmentLimit(options.media, input.imagePath, options.tmpDir);
        const bytes = new Uint8Array(readFileSync(path));
        const saved = await attachments.saveImage({ data: bytes, mediaType: 'image/jpeg', name: 'frame.jpg' });
        const target = llm.imageRequestTarget(input.provider, input.model, saved);
        const selected = await selectRequestImage(target, (next) =>
          attachments.readImageRequest(saved, next, input.signal),
        );
        if (!selected.ok) return { ok: false, kind: 'retryable', message: selected.message };
        let attachment = saved;
        if (selected.prepared.halved) {
          const data = selected.prepared.image.data;
          if (data === undefined) {
            return { ok: false, kind: 'retryable', message: '缩小后的图片没有字节可发送' };
          }
          attachment = await attachments.saveImage({ data, mediaType: 'image/jpeg', name: 'frame.jpg' });
        }
        const prepared = await llm.prepareCall(
          { provider: input.provider, model: input.model },
          input.signal,
        );
        const stream = prepared.stream({
          provider: input.provider,
          model: input.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: input.prompt },
                { type: 'image', attachment },
              ],
            },
          ],
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const fold = createStreamFold();
        for await (const chunk of stream) fold.push(chunk);
        const assembled = fold.result();
        if (!assembled.ok) return assembled;
        return { ok: true, text: assembled.text, tokens: assembled.tokens, ms: Date.now() - started };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
        const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : undefined;
        const retryAfter =
          typeof (error as { providerRetryAfterMs?: unknown }).providerRetryAfterMs === 'number'
            ? (error as { providerRetryAfterMs: number }).providerRetryAfterMs
            : undefined;
        return classifyFailure({
          code,
          message,
          ...(status === undefined ? {} : { status }),
          ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
        });
      }
    },
  };
}

/** Vision client used when the host has no model runtime. Extraction still runs. */
export function unavailableVision(): VisionClient {
  return {
    available: () => false,
    listImageModels: async () => [],
    judge: async () => ({ ok: false, kind: 'unavailable', message: '模型运行时不可用' }),
  };
}
