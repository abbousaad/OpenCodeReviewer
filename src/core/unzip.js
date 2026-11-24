import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * A small, defensive ZIP extractor for uploaded repositories. It reads the
 * central directory, supports stored and deflated entries, and enforces:
 * - no path traversal ("zip slip"): absolute paths and ".." segments are rejected
 * - no symlinks, devices or encrypted entries
 * - file count, per-file and total size limits, checked against the inflated
 *   bytes (not just the declared sizes), so a zip bomb cannot exhaust the disk
 */
export class ZipError extends Error {}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
export const SKIP_SEGMENTS = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', '.svn', '.hg']);

export function safeRelativePath(name) {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) return null;
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

function findEnd(buf) {
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new ZipError('This is not a ZIP file.');
}

/** List the entries of a ZIP buffer without extracting anything. */
function readEntries(buf) {
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported. Upload a smaller archive.');
  }
  if (cdOffset + cdSize > buf.length) throw new ZipError('The ZIP file is truncated or corrupt.');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new ZipError('The ZIP directory is corrupt.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1');
    const unixMode = madeBy === 3 ? externalAttrs >>> 16 : 0;
    entries.push({ name, flags, method, compressedSize, size, localOffset, unixMode });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Extract `zipFile` into the empty directory `dest`.
 * Returns { files, bytes, skipped: { [reason]: count } }.
 */
export function extractZip(zipFile, dest, { maxFiles, maxFileBytes, maxTotalBytes }) {
  const buf = fs.readFileSync(zipFile);
  const entries = readEntries(buf);
  const root = path.resolve(dest);
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

  // Strip one top-level folder when every entry shares it ("project/src/...").
  const names = entries.map((e) => safeRelativePath(e.name)).filter(Boolean);
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/') || n.endsWith('/')) ? [...tops][0] + '/' : '';

  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    if (e.name.endsWith('/') || e.name.endsWith('\\')) continue;
    const rel = safeRelativePath(e.name);
    if (!rel) throw new ZipError(`Unsafe path in archive: ${JSON.stringify(e.name.slice(0, 200))}`);
    const type = e.unixMode & 0o170000;
    if (type && type !== 0o100000) { skip('links or special files'); continue; }
    if (e.flags & 0x1) throw new ZipError('Encrypted ZIP files are not supported.');
    const target = strip && rel.startsWith(strip) ? rel.slice(strip.length) : rel;
    if (!target || target.split('/').some((s) => SKIP_SEGMENTS.has(s))) { skip('ignored folders'); continue; }
    if (e.method !== 0 && e.method !== 8) { skip('unsupported compression'); continue; }
    if (e.size > maxFileBytes) { skip('files over the size limit'); continue; }
    if (files + 1 > maxFiles) throw new ZipError(`The archive has more than ${maxFiles} files.`);
    if (bytes + e.size > maxTotalBytes) throw new ZipError(`The archive expands to more than ${Math.round(maxTotalBytes / 1e6)} MB.`);

    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== LOC) throw new ZipError('The ZIP file is corrupt.');
    const dataStart = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const raw = buf.subarray(dataStart, dataStart + e.compressedSize);
    if (raw.length !== e.compressedSize) throw new ZipError('The ZIP file is truncated.');
    let data;
    try {
      // maxOutputLength stops a lying size field from inflating past the limit.
      data = e.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: e.size + 1 });
    } catch {
      throw new ZipError(`Could not decompress ${target}.`);
    }
    if (data.length !== e.size) throw new ZipError(`The size of ${target} does not match the archive.`);

    const out = path.resolve(root, target);
    if (!out.startsWith(root + path.sep)) throw new ZipError(`Unsafe path in archive: ${JSON.stringify(target)}`);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(out, data, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
        throw new ZipError(`The archive lists ${target} more than once.`);
      }
      throw err;
    }
    files++;
    bytes += data.length;
  }
  if (!files) throw new ZipError('The archive has no files to review.');
  return { files, bytes, skipped };
}
