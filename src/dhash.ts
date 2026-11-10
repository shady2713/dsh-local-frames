/** §6.6: 64-bit dHash, fixed threshold, not a settings field. */
export const DHASH_DISTANCE_MAX = 16;

const GRID_WIDTH = 9;
const GRID_HEIGHT = 8;

/**
 * 64-bit dHash over a 9×8 grid of a grayscale raster.
 * Each bit is 1 when the left sample is strictly brighter than the right one.
 * The result is 16 lowercase hex characters.
 */
export function dhashFromGray(pixels: Uint8Array, width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('灰度图尺寸无效');
  }
  if (pixels.length < width * height) {
    throw new Error('灰度图字节数不足');
  }
  const samples = new Float64Array(GRID_WIDTH * GRID_HEIGHT);
  for (let row = 0; row < GRID_HEIGHT; row += 1) {
    const y0 = Math.floor((row * height) / GRID_HEIGHT);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / GRID_HEIGHT));
    for (let col = 0; col < GRID_WIDTH; col += 1) {
      const x0 = Math.floor((col * width) / GRID_WIDTH);
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * width) / GRID_WIDTH));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y += 1) {
        const offset = y * width;
        for (let x = x0; x < x1 && x < width; x += 1) {
          sum += pixels[offset + x] ?? 0;
          count += 1;
        }
      }
      samples[row * GRID_WIDTH + col] = count === 0 ? 0 : sum / count;
    }
  }
  let bits = 0n;
  for (let row = 0; row < GRID_HEIGHT; row += 1) {
    for (let col = 0; col < GRID_WIDTH - 1; col += 1) {
      const left = samples[row * GRID_WIDTH + col] ?? 0;
      const right = samples[row * GRID_WIDTH + col + 1] ?? 0;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** Hamming distance of two 16-hex-digit hashes. Non-hex input returns 64. */
export function hammingHex(left: string, right: string): number {
  if (!/^[0-9a-f]{16}$/u.test(left) || !/^[0-9a-f]{16}$/u.test(right)) return 64;
  let distance = 0;
  for (let index = 0; index < 16; index += 2) {
    const mixed = Number.parseInt(left.slice(index, index + 2), 16) ^ Number.parseInt(right.slice(index, index + 2), 16);
    let bits = mixed;
    while (bits > 0) {
      distance += bits & 1;
      bits >>= 1;
    }
  }
  return distance;
}

export function isDuplicateHash(left: string, right: string): boolean {
  return hammingHex(left, right) <= DHASH_DISTANCE_MAX;
}

/**
 * §6.2. `durationSeconds` must be finite and positive; the caller treats
 * anything else as a probe failure. There is no per-video frame cap.
 */
export function frameCount(durationSeconds: number, intervalSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error('抽帧间隔必须是不小于 1 的整数秒');
  }
  return Math.max(1, Math.floor(durationSeconds / intervalSeconds));
}

/** §6.3. Returns millisecond timestamps, rounded to the nearest millisecond. */
export function frameTimestampsMs(durationSeconds: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 1) return [];
  const stamps: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const seconds = (durationSeconds * (index + 0.5)) / count;
    stamps.push(Math.round(seconds * 1000));
  }
  return stamps;
}
