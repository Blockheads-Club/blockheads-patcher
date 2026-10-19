import { inflateSync } from 'fflate';
import { crc32 } from './crc32';
import { ZipError, lazyData, rawMethods, sourceOffsets, type ZipArchive, type ZipEntry } from './types';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const utf8 = new TextDecoder('utf-8');

/** Locates the End Of Central Directory record. Throws ZipError for malformed or zip64 archives. */
export function locateEocd(bytes: Uint8Array): { eocdOffset: number; cdOffset: number; cdSize: number; entryCount: number } {
  const dv = view(bytes);
  const min = 22;
  if (bytes.length < min) throw new ZipError('file too small to be a zip');
  const lowest = Math.max(0, bytes.length - min - 0xffff);
  for (let p = bytes.length - min; p >= lowest; p--) {
    if (dv.getUint32(p, true) !== SIG_EOCD) continue;
    const commentLen = dv.getUint16(p + 20, true);
    if (p + min + commentLen !== bytes.length) continue;
    if (p >= 20 && dv.getUint32(p - 20, true) === SIG_ZIP64_LOCATOR) throw new ZipError('zip64 archives are not supported');
    const entryCount = dv.getUint16(p + 10, true);
    const cdSize = dv.getUint32(p + 12, true);
    const cdOffset = dv.getUint32(p + 16, true);
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
    if (cdOffset + cdSize > p) throw new ZipError('central directory out of bounds');
    return { eocdOffset: p, cdOffset, cdSize, entryCount };
  }
  throw new ZipError('end of central directory not found (not a zip file)');
}

/** Parses a zip (APK). The APK signing block between entries and central directory is ignored. */
export function readZip(bytes: Uint8Array): ZipArchive {
  const { eocdOffset, cdOffset, entryCount } = locateEocd(bytes);
  const dv = view(bytes);
  const commentLen = dv.getUint16(eocdOffset + 20, true);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > eocdOffset || dv.getUint32(p, true) !== SIG_CEN) throw new ZipError(`bad central directory entry #${i}`);
    const versionMadeBy = dv.getUint16(p + 4, true);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const modTime = dv.getUint16(p + 12, true);
    const modDate = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const externalAttrs = dv.getUint32(p + 38, true);
    const localOff = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + cmtLen > eocdOffset) throw new ZipError(`central directory entry #${i} overruns`);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const comment = cmtLen ? utf8.decode(bytes.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + cmtLen)) : undefined;
    p += 46 + nameLen + extraLen + cmtLen;

    if (compSize === 0xffffffff || size === 0xffffffff || localOff === 0xffffffff) throw new ZipError('zip64 entries are not supported');
    if (flags & 1) throw new ZipError(`encrypted entry not supported: ${name}`);
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression method ${method}: ${name}`);
    if (seen.has(name)) throw new ZipError(`duplicate entry: ${name}`);
    seen.add(name);

    if (localOff + 30 > bytes.length || dv.getUint32(localOff, true) !== SIG_LOC) throw new ZipError(`bad local header for ${name}`);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > cdOffset) throw new ZipError(`entry data out of bounds: ${name}`);
    const compressed = bytes.subarray(dataStart, dataStart + compSize);
    const lExtra = lExtraLen ? bytes.slice(localOff + 30 + lNameLen, dataStart) : undefined;

    if (method === 0 && compSize !== size) throw new ZipError(`stored entry size mismatch: ${name}`);
    const load = (): Uint8Array => {
      let data: Uint8Array;
      if (method === 0) data = compressed;
      else {
        try {
          data = size === 0 ? new Uint8Array(0) : inflateSync(compressed, { out: new Uint8Array(size) });
        } catch (e) {
          throw new ZipError(`cannot inflate ${name}: ${(e as Error).message}`);
        }
        if (data.length !== size) throw new ZipError(`inflated size mismatch: ${name}`);
      }
      if (crc32(data) !== crc) throw new ZipError(`CRC mismatch: ${name}`);
      return data;
    };
    const entry = {
      name, method, raw: { compressed, crc32: crc, uncompressedSize: size },
      modTime, modDate, extra: lExtra, comment, externalAttrs, versionMadeBy, flags,
    } as ZipEntry;
    // `data` inflates on first read; untouched entries are copied through in compressed form by writeZip.
    let cached: Uint8Array | undefined;
    Object.defineProperty(entry, 'data', {
      enumerable: true, configurable: true,
      get() { if (!cached) { cached = load(); lazyData.delete(entry); } return cached; },
      set(v: Uint8Array) { cached = v; lazyData.delete(entry); },
    });
    lazyData.set(entry, load);
    rawMethods.set(entry, method);
    sourceOffsets.set(entry, localOff);
    entries.push(entry);
  }
  const zipComment = commentLen ? bytes.slice(eocdOffset + 22, eocdOffset + 22 + commentLen) : undefined;
  return { entries, comment: zipComment };
}
