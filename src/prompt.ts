import type { Outcome, TargetAliases, Verdict, Visibility } from './types.js';

/** §7.4: one model call judges at most this many objects. */
export const OBJECTS_PER_CALL = 8;

/**
 * §7.3 definitions, copied verbatim. Callers may only prepend the output
 * schema and append the object table; these sentences are not rewritten.
 */
export const VERDICT_DEFINITIONS = `- PRESENT：画面里能确认这个对象存在。
- ABSENT：画面里明确没有这个对象。只有确实看清整幅画面、能确认没有时才选 ABSENT；看不清、被挡住、太小、拿不准，选 UNSURE。
- UNSURE：看不清、被遮挡、太小、角度不对，无法确认有没有。
- visibility：
  - CLEAR：物体完整、清楚，占画面足够大，可以直接用于检测训练；
  - SMALL：物体较小，但轮廓完整、能确认；
  - TINY：物体小于画面约 1%，细节看不清；
  - OCCLUDED：大部分被其他物体或画面边缘挡住，无法确认。
- confidence：0 到 1 之间的小数，表示模型对 verdict 的把握。
- reason：一句话，不要写与判断无关的内容。`;

const OUTPUT_SCHEMA = `{
  "objects": [
    {
      "name": "对象名（必须与输入对象表里的 name 完全一致）",
      "verdict": "PRESENT | ABSENT | UNSURE",
      "visibility": "CLEAR | SMALL | TINY | OCCLUDED",
      "confidence": 0.0,
      "reason": "一句话理由"
    }
  ]
}`;

export interface PromptObject {
  name: string;
  aliases: TargetAliases;
  definition: string;
}

export interface ModelObject {
  name: string;
  verdict: Verdict;
  visibility: Visibility;
  confidence: number;
  reason: string;
}

const VERDICTS = new Set<Verdict>(['PRESENT', 'ABSENT', 'UNSURE']);
const VISIBILITIES = new Set<Visibility>(['CLEAR', 'SMALL', 'TINY', 'OCCLUDED']);
const OBJECT_KEYS = new Set(['name', 'verdict', 'visibility', 'confidence', 'reason']);

export function chunkObjects<T>(objects: readonly T[], size = OBJECTS_PER_CALL): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < objects.length; index += size) {
    chunks.push(objects.slice(index, index + size));
  }
  return chunks;
}

export function buildPrompt(objects: readonly PromptObject[]): string {
  const table = objects.map((object) =>
    JSON.stringify({
      name: object.name,
      aliases: object.aliases,
      definition: object.definition,
    }),
  );
  return [
    '只输出下面这个 JSON，不要输出其他文字，不要输出 view、real、quality、watermark。',
    OUTPUT_SCHEMA,
    '判断定义：',
    VERDICT_DEFINITIONS,
    '对象表：',
    ...table,
    'objects 里必须恰好包含对象表中的每个 name 一次，name 与对象表完全一致。',
  ].join('\n');
}

export type ParseFailure = { ok: false; message: string };
export type ParseSuccess = { ok: true; objects: ModelObject[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate model JSON before any label row is written. Invalid output is not repaired. */
export function parseModelOutput(text: string, expectedNames: readonly string[]): ParseSuccess | ParseFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    return { ok: false, message: '模型输出不是 JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, message: '模型输出必须是 JSON 对象' };
  for (const key of Object.keys(parsed)) {
    if (key !== 'objects') return { ok: false, message: `模型输出含有未规定的字段 ${key}` };
  }
  const objects = parsed.objects;
  if (!Array.isArray(objects)) return { ok: false, message: '模型输出缺少 objects 数组' };
  const seen = new Set<string>();
  const accepted: ModelObject[] = [];
  for (const entry of objects) {
    if (!isRecord(entry)) return { ok: false, message: 'objects 中有非对象元素' };
    for (const key of Object.keys(entry)) {
      if (!OBJECT_KEYS.has(key)) return { ok: false, message: `对象含有未规定的字段 ${key}` };
    }
    const name = entry.name;
    const verdict = entry.verdict;
    const visibility = entry.visibility;
    const confidence = entry.confidence;
    const reason = entry.reason;
    if (typeof name !== 'string' || !expectedNames.includes(name)) {
      return { ok: false, message: '对象名对不上' };
    }
    if (seen.has(name)) return { ok: false, message: `对象名重复：${name}` };
    seen.add(name);
    if (typeof verdict !== 'string' || !VERDICTS.has(verdict as Verdict)) {
      return { ok: false, message: 'verdict 不合法' };
    }
    if (typeof visibility !== 'string' || !VISIBILITIES.has(visibility as Visibility)) {
      return { ok: false, message: 'visibility 不合法' };
    }
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, message: 'confidence 必须是 0 到 1 的小数' };
    }
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000) {
      return { ok: false, message: 'reason 必须是一句话' };
    }
    accepted.push({
      name,
      verdict: verdict as Verdict,
      visibility: visibility as Visibility,
      confidence,
      reason: reason.trim(),
    });
  }
  for (const name of expectedNames) {
    if (!seen.has(name)) return { ok: false, message: `缺少对象 ${name}` };
  }
  return { ok: true, objects: accepted };
}

/** §7.4. TINY and OCCLUDED are not qualified. UNSURE stays UNSURE. */
export function outcomeFor(verdict: Verdict, visibility: Visibility): Outcome {
  if (verdict === 'UNSURE') return 'UNSURE';
  if (verdict === 'ABSENT') return 'NOT_QUALIFIED';
  if (visibility === 'CLEAR' || visibility === 'SMALL') return 'QUALIFIED';
  return 'NOT_QUALIFIED';
}

/**
 * CSV cell for one object. `1` is QUALIFIED, `0` is an explicit ABSENT,
 * and everything else — including TINY, OCCLUDED, UNSURE, and "not judged" — is empty.
 */
export function csvCell(label: { verdict: Verdict; outcome: Outcome } | null): '' | '0' | '1' {
  if (label === null) return '';
  if (label.outcome === 'QUALIFIED') return '1';
  if (label.verdict === 'ABSENT') return '0';
  return '';
}
