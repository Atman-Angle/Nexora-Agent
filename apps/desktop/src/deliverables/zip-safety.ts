import { unzipSync } from "fflate";

export type ZipSafetyLimits = {
  readonly maxInputBytes: number;
  readonly maxEntries: number;
  readonly maxEntryUncompressedBytes: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxEntryNameBytes: number;
};

export type ZipArchiveStats = {
  readonly entries: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
};

export const DEFAULT_ZIP_SAFETY_LIMITS: ZipSafetyLimits = Object.freeze({
  maxInputBytes: 50_000_000,
  maxEntries: 4_096,
  maxEntryUncompressedBytes: 64_000_000,
  maxTotalUncompressedBytes: 128_000_000,
  maxCompressionRatio: 512,
  maxEntryNameBytes: 1_024
});

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_SEARCH_BYTES = 65_557;

/**
 * Validate the ZIP central directory before fflate materializes any entry.
 * This rejects encrypted, ZIP64, traversal, duplicate-name and high-ratio
 * archives so a small attachment cannot force unbounded decompression.
 */
export function assertZipArchiveWithinLimits(
  bytes: Uint8Array,
  limits: ZipSafetyLimits = DEFAULT_ZIP_SAFETY_LIMITS
): ZipArchiveStats {
  if (bytes.byteLength > limits.maxInputBytes) {
    throw new Error(`ZIP input is ${bytes.byteLength} bytes; maximum is ${limits.maxInputBytes}.`);
  }
  if (bytes.byteLength < EOCD_MIN_BYTES) throw new Error("ZIP archive is too short to contain an end record.");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("ZIP archive is missing its end-of-central-directory record.");

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives exceed the bounded reader limit.");
  }
  if (entries > limits.maxEntries) {
    throw new Error(`ZIP archive contains ${entries} entries; maximum is ${limits.maxEntries}.`);
  }
  if (centralOffset + centralSize > eocd) throw new Error("ZIP central directory is outside the archive.");

  const names = new Set<string>();
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > centralOffset + centralSize) throw new Error("ZIP central directory entry is truncated.");
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("ZIP central directory contains an invalid entry header.");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) throw new Error("ZIP central directory entry exceeds its declared size.");
    if ((flags & 0x0001) !== 0) throw new Error("Encrypted ZIP entries are not supported.");
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`ZIP entry uses unsupported compression method ${compressionMethod}.`);
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error("ZIP64 entries exceed the bounded reader limit.");
    }
    if (nameLength === 0 || nameLength > limits.maxEntryNameBytes) {
      throw new Error("ZIP entry name is empty or exceeds the bounded name limit.");
    }
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assertSafeEntryName(name);
    if (names.has(name)) throw new Error(`ZIP archive contains a duplicate entry name: ${name}.`);
    names.add(name);
    if (uncompressed > limits.maxEntryUncompressedBytes) {
      throw new Error(`ZIP entry ${name} expands to ${uncompressed} bytes; maximum is ${limits.maxEntryUncompressedBytes}.`);
    }
    if (uncompressed > 0 && compressed === 0) {
      throw new Error(`ZIP entry ${name} declares uncompressed data without compressed bytes.`);
    }
    if (compressed > 0 && Math.ceil(uncompressed / compressed) > limits.maxCompressionRatio) {
      throw new Error(`ZIP entry ${name} exceeds the maximum compression ratio of ${limits.maxCompressionRatio}:1.`);
    }
    compressedBytes += compressed;
    uncompressedBytes += uncompressed;
    if (uncompressedBytes > limits.maxTotalUncompressedBytes) {
      throw new Error(`ZIP archive expands beyond ${limits.maxTotalUncompressedBytes} bytes.`);
    }
    cursor = next;
  }
  return { entries, compressedBytes, uncompressedBytes };
}

export function safeUnzipSync(
  bytes: Uint8Array,
  limits: ZipSafetyLimits = DEFAULT_ZIP_SAFETY_LIMITS
): Record<string, Uint8Array> {
  assertZipArchiveWithinLimits(bytes, limits);
  return unzipSync(bytes);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.byteLength - EOCD_MAX_SEARCH_BYTES - EOCD_MIN_BYTES);
  for (let offset = buffer.byteLength - EOCD_MIN_BYTES; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_BYTES + commentLength <= buffer.byteLength) return offset;
  }
  return -1;
}

function assertSafeEntryName(name: string): void {
  const normalized = name.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized)) {
    throw new Error(`ZIP entry has an absolute path: ${name}.`);
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`ZIP entry escapes its package root: ${name}.`);
  }
}
