import { semverToVersion, versionToSemver } from '../patches/versioning';
import { sha256HexSync } from '../elf/sha256';
import { defaultRegistry, createRegistry } from '../patches/registry';
import { PatchError, type ApkInfo, type Patch, type PatchAppliesTo, type PatchContext, type PatchRegistry, type PatchStatus, type PatchTexts } from '../patches/types';
import { CORE_VERSION } from '../version';
import { peekData, readZip, type ZipArchive } from '../zip';
import { validateSchema } from './json-schema';
import { compileOp, type CompileEnv, type CompiledOp, type PackOp } from './ops';
import { PACK_LIMITS, PACK_SCHEMA, PACK_SCHEMA_VERSION } from './schema';

export type Localized = Record<string, string> & { en: string };
export interface PackAppliesTo {
  packageName: string;
  versionNames?: string[];
  versionCodes?: number[];
  sha256?: string[];
}
/** `pack.json` after schema validation. */
export interface PackManifest {
  schemaVersion: number;
  id: string;
  version: string;
  name: Localized;
  description?: Localized;
  author?: string;
  minPatcherVersion?: string;
  appliesTo: PackAppliesTo;
  patches: {
    id: string;
    name: Localized;
    summary?: Localized;
    description: Localized;
    appliesTo?: PackAppliesTo;
    ops: PackOp[];
  }[];
}
export interface Pack {
  id: string;
  version: string;
  name: Localized;
  description?: Localized;
  author?: string;
  /** SHA-256 (hex) of the .bhpack file. */
  sha256: string;
  manifest: PackManifest;
  /** Ready-to-register patches (ids `pack:<packId>/<patchId>`), always opt-in. */
  patches: Patch[];
}
export type PackIssueCode =
  | 'tooLarge' | 'notZip' | 'badEntry' | 'noManifest' | 'badJson' | 'schema' | 'unsupportedSchema' | 'needsNewerPatcher'
  | 'missingFile' | 'unusedFile' | 'badOp' | 'duplicatePatch' | 'overlap';
export interface PackIssue {
  code: PackIssueCode;
  /** JSON pointer (pack.json) or file path the issue is about. */
  path?: string;
  message: string;
}
export type LoadPackResult = { ok: true; pack: Pack } | { ok: false; errors: PackIssue[] };
export interface LoadPackOptions {
  /** Version compared with `minPatcherVersion` (default: CORE_VERSION). */
  patcherVersion?: string;
  /** Lower limits than PACK_LIMITS (tests, constrained hosts); higher values are ignored. */
  limits?: Partial<Record<'packBytes' | 'entries' | 'entryBytes' | 'totalBytes' | 'manifestBytes', number>>;
}

export const PACK_ID_PREFIX = 'pack:';
export const packPatchId = (packId: string, patchId: string): string => `${PACK_ID_PREFIX}${packId}/${patchId}`;
export const isPackPatch = (p: Patch): boolean => p.source?.kind === 'pack';

const MANIFEST = 'pack.json';
const SAFE_ENTRY = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\/?$/;

function cmpVersion(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

class Fail extends Error {
  constructor(readonly issues: PackIssue[]) {
    super(issues[0]!.message);
  }
}
const fail = (code: PackIssueCode, message: string, path?: string): never => {
  throw new Fail([path === undefined ? { code, message } : { code, message, path }]);
};

type Limits = Required<NonNullable<LoadPackOptions['limits']>>;
const mib = (n: number): string => `${Math.round((n / (1 << 20)) * 100) / 100} MiB`;

/** Reads the archive and returns its files (directories dropped) after the size and path checks. */
function readFiles(bytes: Uint8Array, L: Limits): Map<string, Uint8Array> {
  if (bytes.length > L.packBytes) fail('tooLarge', `the pack is larger than ${mib(L.packBytes)}`);
  let zip: ZipArchive;
  try { zip = readZip(bytes); } catch (e) { return fail('notZip', `not a .bhpack (zip) file: ${(e as Error).message}`); }
  if (zip.entries.length > L.entries) fail('tooLarge', `the pack has more than ${L.entries} files`);
  let total = 0;
  const files = new Map<string, Uint8Array>();
  for (const e of zip.entries) {
    if (!SAFE_ENTRY.test(e.name) || e.name.split('/').some((s) => s === '.' || s === '..')) fail('badEntry', `unsafe file name in the pack: ${JSON.stringify(e.name)}`, e.name);
    if (e.name.endsWith('/')) continue;
    const size = e.raw!.uncompressedSize;
    if (size > L.entryBytes) fail('tooLarge', `${e.name} is larger than ${mib(L.entryBytes)}`, e.name);
    total += size;
    if (total > L.totalBytes) fail('tooLarge', `the pack unpacks to more than ${mib(L.totalBytes)}`);
    try { files.set(e.name, peekData(e)); } catch (err) { fail('badEntry', `${e.name}: ${(err as Error).message}`, e.name); }
  }
  return files;
}

function parseManifest(files: Map<string, Uint8Array>, opts: LoadPackOptions, L: Limits): PackManifest {
  const raw = files.get(MANIFEST);
  if (!raw) return fail('noManifest', 'the pack has no pack.json');
  if (raw.length > L.manifestBytes) fail('tooLarge', `pack.json is larger than ${L.manifestBytes} bytes`, MANIFEST);
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch (e) { return fail('badJson', `pack.json is not valid JSON: ${(e as Error).message}`, MANIFEST); }
  const sv = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof sv === 'number' && sv !== PACK_SCHEMA_VERSION) fail('unsupportedSchema', `pack format ${sv} is not supported (this patcher reads format ${PACK_SCHEMA_VERSION})`);
  const issues = validateSchema(PACK_SCHEMA, json);
  if (issues.length) throw new Fail(issues.map((i) => ({ code: 'schema', path: i.path, message: `${i.path || '/'} ${i.message}` })));
  const m = json as PackManifest;
  const have = opts.patcherVersion ?? CORE_VERSION;
  if (m.minPatcherVersion && cmpVersion(m.minPatcherVersion, have) > 0) fail('needsNewerPatcher', `the pack needs Patcher ${m.minPatcherVersion} or newer (this is ${have})`);
  return m;
}

const texts = (p: PackManifest['patches'][number]): Record<string, PatchTexts> => {
  const langs = new Set([...Object.keys(p.name), ...Object.keys(p.description), ...Object.keys(p.summary ?? {})]);
  const out: Record<string, PatchTexts> = {};
  for (const l of langs) {
    const description = p.description[l] ?? p.description.en;
    out[l] = { name: p.name[l] ?? p.name.en, description, summary: p.summary?.[l] ?? p.summary?.en ?? description };
  }
  return out;
};

function toAppliesTo(a: PackAppliesTo): PatchAppliesTo {
  const out: PatchAppliesTo = { packageName: a.packageName };
  if (a.versionNames) out.versionNames = [...a.versionNames];
  if (a.versionCodes) out.versionCode = { min: Math.min(...a.versionCodes), max: Math.max(...a.versionCodes) };
  if (a.sha256) out.sha256 = [...a.sha256];
  return out;
}

/** True when the APK identity is outside what `versionCodes` / `sha256` list exactly (the pipeline checks ranges only). */
const outsideExact = (a: PackAppliesTo, info: ApkInfo): boolean =>
  (!!a.versionCodes && (info.versionCode === undefined || !a.versionCodes.includes(info.versionCode))) || (!!a.sha256 && !a.sha256.includes(info.sha256));

function buildPatch(m: PackManifest, p: PackManifest['patches'][number], ops: CompiledOp[]): Patch {
  const id = packPatchId(m.id, p.id);
  const applies = p.appliesTo ?? m.appliesTo;
  const detect = (ctx: PatchContext): PatchStatus => {
    if (outsideExact(applies, ctx.info)) return 'incompatible';
    const states = ops.map((o) => o.state(ctx));
    if (states.some((s) => s.s === 'blocked')) return 'incompatible';
    return states.every((s) => s.s === 'done') ? 'applied' : 'notApplied';
  };
  return {
    id, version: semverToVersion(m.version)!, versionLabel: versionToSemver,
    nameKey: `patch.${id}.name`, descriptionKey: `patch.${id}.description`,
    appliesTo: toAppliesTo(applies), optIn: true, texts: texts(p),
    source: { kind: 'pack', packId: m.id, packName: m.name.en, packVersion: m.version },
    detect,
    apply(ctx) {
      const status = detect(ctx);
      if (status !== 'notApplied') {
        const why = ops.map((o) => o.state(ctx)).find((s) => s.s === 'blocked');
        throw new PatchError(`${id} cannot be applied (status: ${status}${why?.s === 'blocked' ? `: ${why.why}` : ''})`, 'cannotApply', { status });
      }
      // in declaration order; each operation is checked again because an earlier one may have completed it
      for (const o of ops) if (o.state(ctx).s === 'pending') o.apply(ctx);
      ctx.log(`${id}: applied ${ops.length} operation(s)`);
    },
  };
}

/** Writes of one patch, keyed so that a property-list key edit and a whole-file write of the same path collide. */
export const writesOverlap = (a: string, b: string): boolean => {
  const file = (k: string): string | undefined => (k.startsWith('file:') ? k.slice(5) : k.startsWith('plist:') ? k.slice(6, k.lastIndexOf('#')) : undefined);
  return a === b || ((a.startsWith('file:') || b.startsWith('file:')) && file(a) !== undefined && file(a) === file(b));
};

/** Parses and validates a `.bhpack`. Never runs anything from the pack; every check happens before a Pack is returned. */
export function loadPack(bytes: Uint8Array, opts: LoadPackOptions = {}): LoadPackResult {
  try {
    const L = Object.fromEntries((['packBytes', 'entries', 'entryBytes', 'totalBytes', 'manifestBytes'] as const)
      .map((k) => [k, Math.min(PACK_LIMITS[k], opts.limits?.[k] ?? Infinity)])) as Limits;
    const files = readFiles(bytes, L);
    const m = parseManifest(files, opts, L);
    const used = new Set<string>([MANIFEST]);
    const errors: PackIssue[] = [];
    const seen = new Set<string>();
    const patches: Patch[] = [];
    m.patches.forEach((p, pi) => {
      if (seen.has(p.id)) errors.push({ code: 'duplicatePatch', path: `/patches/${pi}/id`, message: `patch id "${p.id}" is used twice` });
      seen.add(p.id);
      const env: CompileEnv = {
        dexes: [],
        file(path: string): Uint8Array {
          const f = files.get(path);
          if (!f) throw new Fail([{ code: 'missingFile', path, message: `${path} is referenced but not in the pack` }]);
          used.add(path);
          return f;
        },
      };
      const ops: CompiledOp[] = [];
      p.ops.forEach((op, oi) => {
        const at = `/patches/${pi}/ops/${oi}`;
        try { ops.push(compileOp(op, env)); } catch (e) {
          if (e instanceof Fail) errors.push(...e.issues);
          else errors.push({ code: 'badOp', path: at, message: `${at}: ${(e as Error).message}` });
        }
      });
      const mine = ops.flatMap((o) => o.writes);
      mine.forEach((w, i) => {
        if (mine.slice(0, i).some((x) => writesOverlap(x, w))) errors.push({ code: 'overlap', path: `/patches/${pi}`, message: `patch "${p.id}" writes ${w} more than once` });
      });
      const patch = buildPatch(m, p, ops);
      patchWrites.set(patch, mine);
      patches.push(patch);
    });
    for (const name of files.keys()) if (!used.has(name)) errors.push({ code: 'unusedFile', path: name, message: `${name} is not used by any operation` });
    if (errors.length) return { ok: false, errors };
    const pack: Pack = { id: m.id, version: m.version, name: m.name, sha256: sha256HexSync(bytes), manifest: m, patches };
    if (m.description) pack.description = m.description;
    if (m.author) pack.author = m.author;
    return { ok: true, pack };
  } catch (e) {
    /* c8 ignore next */
    if (!(e instanceof Fail)) throw e;
    return { ok: false, errors: e.issues };
  }
}

/** What each pack patch writes (for conflict reports). */
const patchWrites = new WeakMap<Patch, string[]>();

export interface PackConflict {
  /** Full patch ids of the two patches. */
  a: string;
  b: string;
  /** What both write. */
  on: string;
}
export interface PackRegistry {
  registry: PatchRegistry;
  /** Patches (of different packs, or of one pack) that write the same thing; applying both keeps the later one's result. */
  conflicts: PackConflict[];
  /** Packs left out because a pack with the same id came earlier. */
  skipped: string[];
}

/** A registry with the built-in patches followed by every pack's patches (packs in the order given, first id wins). */
export function registryWithPacks(packs: Pack[], base: PatchRegistry = defaultRegistry): PackRegistry {
  const registry = createRegistry(base.list());
  const skipped: string[] = [];
  const all: { id: string; writes: string[] }[] = [];
  const ids = new Set<string>();
  for (const pack of packs) {
    if (ids.has(pack.id)) { skipped.push(pack.id); continue; }
    ids.add(pack.id);
    for (const p of pack.patches) {
      registry.register(p);
      all.push({ id: p.id, writes: patchWrites.get(p)! });
    }
  }
  const conflicts: PackConflict[] = [];
  all.forEach((x, i) => {
    for (const y of all.slice(i + 1)) {
      const on = x.writes.find((a) => y.writes.some((b) => writesOverlap(a, b)));
      if (on) conflicts.push({ a: x.id, b: y.id, on });
    }
  });
  return { registry, conflicts, skipped };
}
