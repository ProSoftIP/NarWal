// Minimal ZIP writer and bounded ZIP reader for .narwal bundles.
//
// The reader treats the archive as hostile: it trusts the central directory
// only after checking it against the local headers, refuses what NarWal never
// writes (encryption, ZIP64, multi-disk, links, methods other than stored and
// deflate) and enforces every limit before it allocates or inflates.
// It never touches a file system; entry names are still validated because the
// same archive is unpacked by people and agents with ordinary tools.

import { NarwalError } from './errors.ts';
import { assertSafePath, pathCollisionKey } from './paths.ts';

const MIB = 1024 * 1024;

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  /** Largest single file after decompression. */
  maxEntryBytes: number;
  /** Sum of all files after decompression. */
  maxTotalBytes: number;
  /** Declared size may not exceed compressed size times this, plus `ratioSlackBytes`. */
  maxCompressionRatio: number;
  ratioSlackBytes: number;
}

// A 30-minute recording measured about 29 MB of Opus (docs/research/16538);
// these leave room for page evidence and stay far below what a tab can hold.
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxArchiveBytes: 512 * MIB,
  maxEntries: 2000,
  maxEntryBytes: 512 * MIB,
  maxTotalBytes: 1024 * MIB,
  maxCompressionRatio: 200,
  ratioSlackBytes: 64 * 1024,
});

export interface ZipInput {
  path: string;
  bytes: Uint8Array;
  /** Deflate the entry. Leave false for media that is already compressed. */
  compress: boolean;
}

export interface ZipEntry {
  path: string;
  /** Size after decompression, from the central directory. */
  size: number;
  compressedSize: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** Inflates one entry and verifies its length and CRC-32. */
  read(path: string): Promise<Uint8Array>;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_DIRECTORY = 0x2000;
// 1980-01-01 00:00:00, the DOS epoch. A fixed stamp keeps bundles
// reproducible and keeps the exporter's clock out of the archive headers.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await written;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Inflates into a buffer of exactly `expected` bytes and stops at the first byte beyond it. */
async function inflateRaw(bytes: Uint8Array, expected: number, path: string): Promise<Uint8Array> {
  const corrupt = (why: string) =>
    new NarwalError('entry-corrupt', `Bundle file "${path}" is damaged: ${why}`, { path });
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  // The read loop reports the failure; this keeps the rejection handled.
  written.catch(() => {});
  const reader = stream.readable.getReader();
  const out = new Uint8Array(expected);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > expected) {
        await reader.cancel().catch(() => {});
        throw corrupt('it is larger than the archive declares');
      }
      out.set(value, length);
      length += value.length;
    }
    await written;
  } catch (error) {
    if (error instanceof NarwalError) throw error;
    throw corrupt('the compressed data is invalid');
  }
  if (length !== expected) throw corrupt('it is smaller than the archive declares');
  return out;
}

export async function writeZip(inputs: ZipInput[]): Promise<Uint8Array> {
  if (inputs.length > 0xfffe) {
    throw new NarwalError('archive-too-many-entries', 'Too many files for one bundle', {
      entries: inputs.length,
    });
  }
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const input of inputs) {
    assertSafePath(input.path);
    const key = pathCollisionKey(input.path);
    if (seen.has(key)) {
      throw new NarwalError('entry-duplicate', `Two bundle files share the name "${input.path}"`, {
        path: input.path,
      });
    }
    seen.add(key);

    const name = encoder.encode(input.path);
    let method = METHOD_STORED;
    let data = input.bytes;
    if (input.compress && input.bytes.length > 0) {
      const deflated = await deflateRaw(input.bytes);
      if (deflated.length < input.bytes.length) {
        method = METHOD_DEFLATE;
        data = deflated;
      }
    }
    if (input.bytes.length >= 0xffffffff || offset + data.length + name.length + 30 >= 0xffffffff) {
      throw new NarwalError('archive-too-large', 'Recording is too large for one bundle', {
        path: input.path,
      });
    }
    const crc = crc32(input.bytes);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, input.bytes.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // made by: FAT attributes, so no Unix mode bits
    cv.setUint16(6, 20, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, input.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize + 22 >= 0xffffffff) {
    throw new NarwalError('archive-too-large', 'Recording is too large for one bundle');
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, inputs.length, true);
  ev.setUint16(10, inputs.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let position = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

interface CentralRecord extends ZipEntry {
  method: number;
  crc: number;
  dataStart: number;
}

function malformed(why: string, detail: Record<string, unknown> = {}): NarwalError {
  return new NarwalError('archive-malformed', `Not a valid NarWal bundle: ${why}`, detail);
}

function unsupported(why: string, detail: Record<string, unknown> = {}): NarwalError {
  return new NarwalError('archive-unsupported', `Bundle uses an archive feature NarWal refuses: ${why}`, detail);
}

function findEndOfCentralDirectory(view: DataView): number {
  const length = view.byteLength;
  // The record is 22 bytes plus a comment of at most 65535 bytes.
  const lowest = Math.max(0, length - 22 - 0xffff);
  for (let position = length - 22; position >= lowest; position -= 1) {
    if (view.getUint32(position, true) !== SIG_EOCD) continue;
    if (position + 22 + view.getUint16(position + 20, true) === length) return position;
  }
  throw malformed('the archive directory is missing');
}

export function openZip(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ZipArchive {
  if (bytes.length > limits.maxArchiveBytes) {
    throw new NarwalError('archive-too-large', 'Bundle file is larger than NarWal imports', {
      bytes: bytes.length,
      limit: limits.maxArchiveBytes,
    });
  }
  if (bytes.length < 22) throw malformed('the file is too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);

  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) throw unsupported('ZIP64');
  const diskNumber = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw unsupported('ZIP64');
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw unsupported('multi-disk archive');
  }
  if (entryCount > limits.maxEntries) {
    throw new NarwalError('archive-too-many-entries', 'Bundle holds more files than NarWal imports', {
      entries: entryCount,
      limit: limits.maxEntries,
    });
  }
  if (directoryOffset + directorySize !== eocd) throw malformed('the archive directory is misplaced');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const records: CentralRecord[] = [];
  const seen = new Set<string>();
  const ranges: Array<{ start: number; end: number; path: string }> = [];
  let total = 0;
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== SIG_CENTRAL) {
      throw malformed('a directory record is damaged', { index });
    }
    const madeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw malformed('a directory record runs past the directory', { index });

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let path: string;
    try {
      path = decoder.decode(nameBytes);
    } catch {
      throw new NarwalError('entry-path-unsafe', 'Unsafe file name in bundle: not UTF-8', { index });
    }
    cursor = next;

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_DIRECTORY)) {
      throw unsupported('encryption', { index });
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw unsupported('ZIP64', { index });
    }
    if (diskStart !== 0) throw unsupported('multi-disk archive', { index });
    // Unix hosts put the file mode in the high word; refuse anything but a regular file or directory.
    if (madeBy >>> 8 === 3) {
      const type = (externalAttributes >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
        throw new NarwalError('entry-path-unsafe', 'Unsafe file in bundle: link or special file', { index });
      }
    }

    const isDirectory = path.endsWith('/');
    if (isDirectory) {
      // Ordinary zip tools add directory records; they hold no data.
      if (size !== 0 || compressedSize !== 0) throw malformed('a directory record holds data', { index });
      assertSafePath(path.slice(0, -1));
      continue;
    }
    assertSafePath(path);
    const key = pathCollisionKey(path);
    if (seen.has(key)) {
      throw new NarwalError('entry-duplicate', `Bundle holds two files named "${path}"`, { path });
    }
    seen.add(key);

    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw unsupported(`compression method ${method}`, { path });
    }
    if (method === METHOD_STORED && compressedSize !== size) {
      throw malformed('a stored file has two different sizes', { path });
    }
    if (size > limits.maxEntryBytes) {
      throw new NarwalError('entry-too-large', `Bundle file "${path}" is larger than NarWal imports`, {
        path,
        bytes: size,
        limit: limits.maxEntryBytes,
      });
    }
    if (size > compressedSize * limits.maxCompressionRatio + limits.ratioSlackBytes) {
      throw new NarwalError('entry-ratio', `Bundle file "${path}" expands more than NarWal allows`, {
        path,
        bytes: size,
        compressedBytes: compressedSize,
      });
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new NarwalError('total-too-large', 'Bundle contents are larger than NarWal imports', {
        limit: limits.maxTotalBytes,
      });
    }

    // The local header must agree with the directory, or two readers could see two different archives.
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw malformed('a file header is missing', { path });
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localFlags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw unsupported('encryption', { path });
    if (localMethod !== method) throw malformed('a file header disagrees with the directory', { path });
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localNameLength !== nameLength || !localName.every((byte, i) => byte === nameBytes[i])) {
      throw malformed('a file header names a different file', { path });
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset) throw malformed('a file runs past the archive data', { path });

    ranges.push({ start: localOffset, end: dataEnd, path });
    records.push({ path, size, compressedSize, method, crc, dataStart });
  }
  if (cursor !== eocd) throw malformed('the archive directory has trailing data');

  // Overlapping files are how a small archive claims a huge total.
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1] as (typeof ranges)[number];
    const current = ranges[i] as (typeof ranges)[number];
    if (current.start < previous.end) {
      throw new NarwalError('entry-overlap', 'Bundle files overlap inside the archive', {
        paths: [previous.path, current.path],
      });
    }
  }

  const byPath = new Map(records.map((record) => [record.path, record]));
  return {
    entries: records.map(({ path, size, compressedSize }) => ({ path, size, compressedSize })),
    async read(path: string): Promise<Uint8Array> {
      const record = byPath.get(path);
      if (!record) throw new NarwalError('file-missing', `Bundle has no file "${path}"`, { path });
      const data = bytes.subarray(record.dataStart, record.dataStart + record.compressedSize);
      // slice() copies, so the result does not keep the whole archive alive.
      const content = record.method === METHOD_STORED ? data.slice() : await inflateRaw(data, record.size, path);
      if (crc32(content) !== record.crc) {
        throw new NarwalError('entry-corrupt', `Bundle file "${path}" is damaged: checksum mismatch`, { path });
      }
      return content;
    },
  };
}
