/** §7.6 attachment hard limits: 20 MiB, long edge 8192, 64 million pixels. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_EDGE = 8192;
export const ATTACHMENT_MAX_PIXELS = 64_000_000;

export interface RasterBox {
  width: number;
  height: number;
}

export function exceedsAttachmentLimits(width: number, height: number, bytes: number): boolean {
  return (
    bytes > ATTACHMENT_MAX_BYTES ||
    Math.max(width, height) > ATTACHMENT_MAX_EDGE ||
    width * height > ATTACHMENT_MAX_PIXELS
  );
}

/** Scale factors that bring one raster inside the attachment hard limits. */
export function fitAttachmentBox(width: number, height: number, bytes: number): RasterBox {
  let scale = 1;
  const edge = Math.max(width, height);
  if (edge > ATTACHMENT_MAX_EDGE) scale = Math.min(scale, ATTACHMENT_MAX_EDGE / edge);
  const pixels = width * height;
  if (pixels > ATTACHMENT_MAX_PIXELS) scale = Math.min(scale, Math.sqrt(ATTACHMENT_MAX_PIXELS / pixels));
  if (bytes > ATTACHMENT_MAX_BYTES && bytes > 0) {
    scale = Math.min(scale, Math.sqrt(ATTACHMENT_MAX_BYTES / bytes) * 0.9);
  }
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export interface ImageRequestTarget {
  width: number;
  height: number;
  maxBytes: number;
}

export interface RequestImageLike {
  bytes: number;
  width: number;
  height: number;
  withinMaxBytes?: boolean;
  data?: Uint8Array;
}

export function withinByteTarget(image: RequestImageLike, target: ImageRequestTarget): boolean {
  if (typeof image.withinMaxBytes === 'boolean') return image.withinMaxBytes;
  return image.bytes <= target.maxBytes;
}

/** Halve the target edge once, which is the only retry §7.6 allows. */
export function halvedTarget(target: ImageRequestTarget): ImageRequestTarget {
  return {
    width: Math.max(1, Math.floor(target.width / 2)),
    height: Math.max(1, Math.floor(target.height / 2)),
    maxBytes: target.maxBytes,
  };
}

export interface PreparedRequestImage {
  target: ImageRequestTarget;
  image: RequestImageLike;
  halved: boolean;
}

/**
 * Ask the host for the model-sized image. If the first result is over the
 * byte target, halve the edge and read once more. A second miss is a failure.
 */
export async function selectRequestImage(
  initial: ImageRequestTarget,
  read: (target: ImageRequestTarget) => Promise<RequestImageLike>,
): Promise<{ ok: true; prepared: PreparedRequestImage } | { ok: false; message: string }> {
  const first = await read(initial);
  if (withinByteTarget(first, initial)) {
    return { ok: true, prepared: { target: initial, image: first, halved: false } };
  }
  const smaller = halvedTarget(initial);
  const second = await read(smaller);
  if (!withinByteTarget(second, smaller)) {
    return { ok: false, message: '图片缩小后仍超过模型字节上限' };
  }
  return { ok: true, prepared: { target: smaller, image: second, halved: true } };
}
