import { getEntry, peekData, setEntry, type ZipArchive } from './zip';
import { isPatchVersion } from './patches/versioning';

/** Where the Patcher leaves its record in a patched APK. */
export const RECORD_PATH = 'assets/blockheads-patcher.json';
export const RECORD_SCHEMA = 1;

/**
 * What a Patcher run left in an APK: the Patcher version and, for every patch whose output the APK holds, the version
 * of that output. Small and deterministic (sorted keys, no whitespace); written before signing.
 */
export interface PatcherRecord {
  schema: typeof RECORD_SCHEMA;
  /** @bh-patcher/core version that wrote the record. */
  patcher: string;
  /** Patch id to the version of the output in the APK. */
  patches: Record<string, number>;
}

/** The record as bytes: keys sorted, no whitespace, so equal input gives equal bytes. */
export function serializeRecord(r: PatcherRecord): Uint8Array {
  const patches = Object.fromEntries(Object.keys(r.patches).sort().map((id) => [id, r.patches[id]]));
  return new TextEncoder().encode(JSON.stringify({ patcher: r.patcher, patches, schema: r.schema }));
}

/** Parses a record; undefined for anything that is not a valid one (a damaged record counts as no record). Bad entries are dropped. */
export function parseRecord(bytes: Uint8Array): PatcherRecord | undefined {
  let json: { schema?: unknown; patcher?: unknown; patches?: unknown };
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return undefined; }
  if (!json || json.schema !== RECORD_SCHEMA || typeof json.patcher !== 'string') return undefined;
  const raw = json.patches;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const patches: Record<string, number> = {};
  for (const [id, v] of Object.entries(raw)) if (isPatchVersion(v)) patches[id] = v;
  return { schema: RECORD_SCHEMA, patcher: json.patcher, patches };
}

/** Reads the record of an APK; undefined when it has none (an APK from before records, or never patched). */
export function readRecord(zip: ZipArchive): PatcherRecord | undefined {
  const e = getEntry(zip, RECORD_PATH);
  return e ? parseRecord(peekData(e)) : undefined;
}

/** Puts the record into the archive (replacing an older one). */
export function writeRecord(zip: ZipArchive, r: PatcherRecord): void {
  setEntry(zip, { name: RECORD_PATH, data: serializeRecord(r) });
}
