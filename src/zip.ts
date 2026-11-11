import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  /** Archive path using `/` separators. */
  name: string;
  /** Read from this absolute file path, or use the given bytes. */
  source: string | Buffer;
  /** JPEG and other already-compressed payloads stay stored; text is deflated. */
  compress: boolean;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION = 20;

let crcTable: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  method: number;
  time: number;
  date: number;
  localOffset: number;
}

function readEntry(source: string | Buffer): Buffer {
  return typeof source === 'string' ? readFileSync(source) : source;
}

/**
 * Write a zip archive without third-party dependencies (`node:zlib` deflate).
 * The archive is created with `wx`, so an existing zip is never overwritten;
 * a partially written file is removed when writing fails.
 */
export function writeZip(file: string, entries: readonly ZipEntryInput[], now: Date = new Date()): void {
  const stamp = dosTimestamp(now);
  const central: CentralRecord[] = [];
  let offset = 0;
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (error) {
    throw error;
  }
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      if (name.length === 0 || name.length > 0xffff) throw new Error(`zip 条目名无效：${entry.name}`);
      const data = readEntry(entry.source);
      const compressed = entry.compress ? deflateRawSync(data) : data;
      const method = entry.compress ? 8 : 0;
      const crc = crc32(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIGNATURE, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(UTF8_FLAG, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      writeSync(fd, local);
      writeSync(fd, name);
      writeSync(fd, compressed);

      central.push({
        name,
        crc,
        compressedSize: compressed.length,
        size: data.length,
        method,
        time: stamp.time,
        date: stamp.date,
        localOffset: offset,
      });
      offset += local.length + name.length + compressed.length;
    }

    const centralStart = offset;
    for (const record of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      header.writeUInt16LE(VERSION, 4);
      header.writeUInt16LE(VERSION, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(record.time, 12);
      header.writeUInt16LE(record.date, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.compressedSize, 20);
      header.writeUInt32LE(record.size, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(record.localOffset, 42);
      writeSync(fd, header);
      writeSync(fd, record.name);
      offset += header.length + record.name.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIGNATURE, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    writeSync(fd, end);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // keep the original failure
    }
    try {
      unlinkSync(file);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
  closeSync(fd);
}
