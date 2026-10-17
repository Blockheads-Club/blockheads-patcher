import type { ZipArchive, ZipEntry } from './types';

export function getEntry(zip: ZipArchive, name: string): ZipEntry | undefined {
  return zip.entries.find((e) => e.name === name);
}

/** Replaces an entry in place (keeps position, method and metadata unless overridden) or appends a new one (default DEFLATE). */
export function setEntry(zip: ZipArchive, entry: Pick<ZipEntry, 'name' | 'data'> & Partial<ZipEntry>): void {
  const i = zip.entries.findIndex((e) => e.name === entry.name);
  const old = i >= 0 ? zip.entries[i]! : undefined;
  const merged: ZipEntry = {
    method: old?.method ?? 8,
    modTime: old?.modTime ?? 0,
    modDate: old?.modDate ?? 0x0021, // 1980-01-01, deterministic
    externalAttrs: old?.externalAttrs ?? 0,
    versionMadeBy: old?.versionMadeBy ?? 20,
    flags: old ? old.flags : 0,
    comment: old?.comment,
    extra: old?.extra,
    ...entry,
    raw: entry.raw, // never inherit stale raw data from the replaced entry
  };
  if (i >= 0) zip.entries[i] = merged;
  else zip.entries.push(merged);
}

export function removeEntry(zip: ZipArchive, name: string): boolean {
  const i = zip.entries.findIndex((e) => e.name === name);
  if (i < 0) return false;
  zip.entries.splice(i, 1);
  return true;
}

const SIG_RE = /^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]*)$/i;

/** Removes v1 signature files (META-INF/MANIFEST.MF, *.SF, *.RSA, *.DSA, *.EC, SIG-*). Returns removed names. */
export function removeSignatureFiles(zip: ZipArchive): string[] {
  const removed: string[] = [];
  zip.entries = zip.entries.filter((e) => {
    if (SIG_RE.test(e.name)) { removed.push(e.name); return false; }
    return true;
  });
  return removed;
}
