import { setEntry, writeZip, type ZipArchive } from '../zip';

/**
 * Builds a deterministic `.bhpack` from files keyed by their path inside the pack: `pack.json` first, the rest sorted by
 * name, fixed timestamps, DEFLATE. The result is not validated; run loadPack on it.
 */
export function buildPackArchive(files: Record<string, Uint8Array>): Uint8Array {
  const zip: ZipArchive = { entries: [] };
  const names = Object.keys(files).sort((a, b) => Number(b === 'pack.json') - Number(a === 'pack.json') || (a < b ? -1 : 1));
  for (const name of names) setEntry(zip, { name, data: files[name]! });
  return writeZip(zip);
}
