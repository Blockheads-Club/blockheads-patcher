export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** UTF-8 path, no leading slash; directories end with '/'. */
  name: string;
  /** 0 = STORE, 8 = DEFLATE. */
  method: 0 | 8;
  /** UNCOMPRESSED content. */
  data: Uint8Array;
  /** Present for entries read from a zip: compressed bytes + crc32 to allow copy-through without recompress. */
  raw?: { compressed: Uint8Array; crc32: number; uncompressedSize: number };
  modTime: number;
  modDate: number;
  /** Local extra field (dropped for STORED entries, which get alignment padding instead). */
  extra?: Uint8Array;
  comment?: string;
  externalAttrs: number;
  versionMadeBy: number;
  /** General purpose flags; bit 3 (data descriptor) is cleared on write. */
  flags: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  comment?: Uint8Array;
}

export interface WriteZipOptions {
  /** Alignment of STORED entry data, default 4. */
  alignment?: number;
  /** Alignment of STORED `*.so` entries, default 4096. */
  soAlignment?: number;
}

/** Internal: compression method an entry's `raw` bytes were stored with. */
export const rawMethods = new WeakMap<object, number>();

/**
 * Internal: entries read from a zip inflate lazily. While an entry is in this map its `data` has not been
 * materialized; the value inflates (and CRC-checks) without caching. Deleted once `data` is read or assigned.
 */
export const lazyData = new WeakMap<object, () => Uint8Array>();

/** Internal: offset of an entry's local header in the zip it was read from (identifies the entry within that file). */
export const sourceOffsets = new WeakMap<object, number>();

/** Internal: SHA-256 (hex) of the bytes an archive was read from, when the caller computed it (see loadApk). */
export const sourceSha256 = new WeakMap<object, string>();

/** Uncompressed bytes of an entry without retaining them on the entry (keeps untouched entries lazy). */
export function peekData(e: ZipEntry): Uint8Array {
  const load = lazyData.get(e);
  return load ? load() : e.data;
}
