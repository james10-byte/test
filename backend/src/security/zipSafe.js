import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { AppError } from '../errors.js';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const MAXIMUM_RATIO = 1000;
const RATIO_FLOOR_BYTES = 1024 * 1024;

const fail = (code, message) => new AppError(422, code, message);

function locateEnd(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw fail('invalid_zip', 'The file is not a valid ZIP archive.');
}

function splitName(rawName) {
  if (rawName.includes('\0')) throw fail('unsafe_path', 'The archive contains an invalid file name.');
  const unified = rawName.replaceAll('\\', '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw fail('absolute_path', 'The archive contains an absolute path.');
  }
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw fail('path_traversal', 'The archive contains a path that escapes the project directory.');
  }
  return segments;
}

export function readZipEntries(buffer, limits) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw fail('invalid_zip', 'The file is not a valid ZIP archive.');
  }
  if (buffer.length > limits.maxCompressedBytes) {
    throw fail('archive_too_large', 'The ZIP archive exceeds the allowed upload size.');
  }
  const endOffset = locateEnd(buffer);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw fail('unsupported_zip', 'ZIP64 archives are not supported.');
  }
  if (totalEntries > limits.maxFiles) {
    throw fail('too_many_files', 'The archive contains too many files.');
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw fail('invalid_zip', 'The ZIP directory is corrupted.');
  }
  const entries = [];
  const seen = new Set();
  let totalBytes = 0;
  let position = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
      throw fail('invalid_zip', 'The ZIP directory is corrupted.');
    }
    const versionMadeBy = buffer.readUInt16LE(position + 4);
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const externalAttributes = buffer.readUInt32LE(position + 38);
    const localOffset = buffer.readUInt32LE(position + 42);
    const nameEnd = position + 46 + nameLength;
    if (nameEnd > buffer.length) throw fail('invalid_zip', 'The ZIP directory is corrupted.');
    const rawName = buffer.toString('utf8', position + 46, nameEnd);
    position = nameEnd + extraLength + commentLength;

    if ((flags & 1) !== 0) throw fail('encrypted_zip', 'Encrypted archives are not supported.');
    const hostSystem = versionMadeBy >> 8;
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (hostSystem === 3 && unixType === 0xa000) {
      throw fail('symlink_rejected', 'The archive contains a symbolic link.');
    }
    const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\');
    const segments = splitName(rawName);
    if (segments.length === 0) continue;
    if (segments.length > limits.maxDepth) {
      throw fail('too_deep', 'The archive contains directories nested too deeply.');
    }
    if (segments[0] === '__MACOSX' || IGNORED_NAMES.has(segments[segments.length - 1])) continue;
    const key = segments.join('/').toLowerCase();
    if (seen.has(key)) throw fail('duplicate_entry', 'The archive contains duplicate file names.');
    seen.add(key);
    if (isDirectory) {
      entries.push({ segments, relativePath: segments.join('/'), directory: true });
      continue;
    }
    if (method !== 0 && method !== 8) {
      throw fail('unsupported_compression', 'The archive uses an unsupported compression method.');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw fail('unsupported_zip', 'ZIP64 archives are not supported.');
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw fail('entry_too_large', 'A file inside the archive is too large.');
    }
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxExtractedBytes) {
      throw fail('archive_too_large_extracted', 'The extracted archive would exceed the allowed size.');
    }
    if (uncompressedSize > RATIO_FLOOR_BYTES && uncompressedSize / Math.max(compressedSize, 1) > MAXIMUM_RATIO) {
      throw fail('suspicious_compression_ratio', 'The archive has a suspicious compression ratio.');
    }
    entries.push({
      segments,
      relativePath: segments.join('/'),
      directory: false,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset
    });
  }
  return { entries, totalBytes };
}

function readEntryData(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw fail('invalid_zip', 'The ZIP archive is corrupted.');
  }
  const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw fail('invalid_zip', 'The ZIP archive is corrupted.');
  const raw = buffer.subarray(start, end);
  let data;
  if (entry.method === 0) {
    data = raw;
  } else {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
    } catch {
      throw fail('corrupt_entry', 'A file inside the archive is corrupted.');
    }
  }
  if (data.length !== entry.uncompressedSize || zlib.crc32(data) !== entry.crc) {
    throw fail('corrupt_entry', 'A file inside the archive is corrupted.');
  }
  return data;
}

export async function extractZip(buffer, destination, limits) {
  const { entries, totalBytes } = readZipEntries(buffer, limits);
  if (!entries.some((entry) => !entry.directory)) {
    throw fail('empty_archive', 'The archive does not contain any files.');
  }
  const root = path.resolve(destination);
  await fs.mkdir(root, { recursive: true });
  const files = [];
  for (const entry of entries) {
    const target = path.resolve(root, ...entry.segments);
    if (!target.startsWith(root + path.sep)) {
      throw fail('path_traversal', 'The archive contains a path that escapes the project directory.');
    }
    try {
      if (entry.directory) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      const data = readEntryData(buffer, entry);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data, { flag: 'wx', mode: 0o644 });
      files.push(entry.relativePath);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw fail('conflicting_entries', 'The archive contains conflicting file or directory names.');
    }
  }
  return { files, totalBytes };
}
