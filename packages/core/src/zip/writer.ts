import { deflateSync } from 'fflate';
import { crc32 } from './crc32';
import { ZipError, lazyData, rawMethods, type WriteZipOptions, type ZipArchive, type ZipEntry } from './types';

const enc = new TextEncoder();
const isAscii = (b: Uint8Array) => b.every((c) => c < 0x80);

function alignmentFor(e: ZipEntry, a: number, so: number): number {
  return e.name.toLowerCase().endsWith('.so') ? so : a;
}

/** Entry can be copied through when its uncompressed data still matches the crc/size read from the source. */
function canCopyThrough(e: ZipEntry): boolean {
  const r = e.raw;
  if (!r) return false;
  if (rawMethods.get(e) !== e.method) return false;
  if (lazyData.has(e)) return true; // never read or assigned: still identical to the source
  if (e.data.length !== r.uncompressedSize) return false;
  return crc32(e.data) === r.crc32;
}

/** Serializes the archive. STORED entries are aligned by padding the local extra field (zipalign semantics). */
export function writeZip(zip: ZipArchive, opts: WriteZipOptions = {}): Uint8Array {
  const align = opts.alignment ?? 4;
  const soAlign = opts.soAlignment ?? 4096;
  if (zip.entries.length > 0xfffe) throw new ZipError('too many entries (zip64 not supported)');

  const chunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  let pos = 0;
  let cdSize = 0;

  for (const e of zip.entries) {
    const nameBytes = enc.encode(e.name);
    const cmtBytes = e.comment ? enc.encode(e.comment) : new Uint8Array(0);
    let flags = e.flags & ~0x0008;
    if (!isAscii(nameBytes) || !isAscii(cmtBytes)) flags |= 0x0800;

    let crc: number, compressed: Uint8Array, size: number;
    if (canCopyThrough(e)) {
      crc = e.raw!.crc32; compressed = e.raw!.compressed; size = e.raw!.uncompressedSize;
      // copy-through of a method-8 entry keeps the original deflate stream
    } else {
      size = e.data.length;
      crc = crc32(e.data);
      compressed = e.method === 0 ? e.data : deflateSync(e.data, { level: 6 });
    }
    if (pos > 0xffffffff - compressed.length - 0x2000 || size > 0xffffffff) throw new ZipError('archive too large (zip64 not supported)');
    if (nameBytes.length > 0xffff || cmtBytes.length > 0xffff) throw new ZipError(`name/comment too long: ${e.name}`);

    let extra: Uint8Array;
    if (e.method === 0 && !e.name.endsWith('/')) {
      const a = alignmentFor(e, align, soAlign);
      const base = pos + 30 + nameBytes.length;
      const pad = a > 1 ? (a - (base % a)) % a : 0;
      extra = new Uint8Array(pad);
    } else {
      extra = e.extra ?? new Uint8Array(0);
    }
    if (extra.length > 0xffff) throw new ZipError(`extra field too long: ${e.name}`);

    const lh = new Uint8Array(30 + nameBytes.length + extra.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, e.modTime, true);
    lv.setUint16(12, e.modDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, extra.length, true);
    lh.set(nameBytes, 30);
    lh.set(extra, 30 + nameBytes.length);

    const ch = new Uint8Array(46 + nameBytes.length + cmtBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, e.versionMadeBy, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.modTime, true);
    cv.setUint16(14, e.modDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, cmtBytes.length, true);
    cv.setUint32(38, e.externalAttrs, true);
    cv.setUint32(42, pos, true);
    ch.set(nameBytes, 46);
    ch.set(cmtBytes, 46 + nameBytes.length);

    chunks.push(lh, compressed);
    cdChunks.push(ch);
    pos += lh.length + compressed.length;
    cdSize += ch.length;
  }

  const comment = zip.comment ?? new Uint8Array(0);
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, zip.entries.length, true);
  ev.setUint16(10, zip.entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, pos, true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);

  const out = new Uint8Array(pos + cdSize + eocd.length);
  let o = 0;
  for (const c of [...chunks, ...cdChunks, eocd]) { out.set(c, o); o += c.length; }
  return out;
}
