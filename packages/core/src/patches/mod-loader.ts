import { ValueType, findElementsByName, getAttr, setAttrString, type AxmlAttribute } from '../axml';
import { validateDex } from '../dex';
import { sha256HexSync } from '../elf/sha256';
import { getEntry, peekData, readZip, setEntry, type ZipArchive } from '../zip';
import { openDexSet } from './dex-support';
import { BLOCKHEADS_PACKAGE } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';
import { semverToVersion, versionToSemver } from './versioning';

/**
 * The Blockheads Club mod loader (mod-sdk `crates/bhmod-android`): `libbhmodloader.so` (armeabi-v7a) plus its Java
 * UI (`classes.dex`), built by mod-sdk CI as `bhmod-android-loader-<version>.zip` with a `loader.json`. The Patcher
 * pins that zip by SHA-256 and the app ships or fetches exactly those bytes.
 */
export interface ModLoaderPin {
  version: string;
  /** Release asset of Blockheads-Club/mod-sdk. */
  url: string;
  /** SHA-256 (lowercase hex) of the zip. */
  sha256: string;
  size: number;
  /** SHA-256 of `libbhmodloader.so` / `classes.dex` inside the zip (from loader.json). A game carrying another build counts as not applied even before the zip is loaded. */
  libSha256: string;
  dexSha256: string;
}

/** The loader build this Patcher version installs. */
export const MOD_LOADER_PIN: ModLoaderPin = {
  version: '0.3.1',
  url: 'https://github.com/Blockheads-Club/mod-sdk/releases/download/v0.3.1/bhmod-android-loader-0.3.1.zip',
  sha256: '0a2c4dfb8fd8d756ed35872f533497fab378a86857e74cbdd07f024ef519ae87',
  size: 12350316,
  libSha256: '0ae8b8a293f0d8b96e18100878a8b2f515042973d47b8e4434a8ad5d85dec662',
  dexSha256: '1e5cf29a1666e84513eca492f750016b510ef144cec8c4dfce782b717e369a39',
};

/**
 * `libbhmodloader.so` hashes of earlier loader builds the Patcher shipped, by version. They let an APK without a
 * record say which loader it carries ("Update: 0.3.0 to 0.3.1"); a build that is not listed still counts as older.
 */
export const KNOWN_LOADER_LIBS: Readonly<Record<string, string>> = {
  '2083a5a1134dcacaff5c555de6f9e72817a48b6a414b643f503eab08d2499a6e': '0.3.0',
  [MOD_LOADER_PIN.libSha256]: MOD_LOADER_PIN.version,
};

/** File name of the pinned zip (app static assets serve it under `mod-loader/`). */
export const modLoaderFileName = (pin: ModLoaderPin = MOD_LOADER_PIN): string => `bhmod-android-loader-${pin.version}.zip`;

/** Name in `android.app.libs` (Apportable loads `lib<name>.so` after libApplication). */
export const MOD_LOADER_LIB = 'bhmodloader';
export const MOD_LOADER_LIB_PATH = `lib/armeabi-v7a/lib${MOD_LOADER_LIB}.so`;
/** Class in `apportable.app.lifecycle_listeners`. */
export const MOD_LOADER_LISTENER = 'com.blockheadsclub.modloader.Listener';
export const MOD_LOADER_LISTENER_CLASS = `L${MOD_LOADER_LISTENER.replaceAll('.', '/')};`;
export const MOD_LOADER_PACKAGE = 'Lcom/blockheadsclub/modloader/';
const LIFECYCLE_LISTENER = 'Lcom/apportable/Lifecycle$Listener;';
const LIBS_META = 'android.app.libs';
const LISTENERS_META = 'apportable.app.lifecycle_listeners';
const ID_VALUE = 0x01010024;
const EM_ARM = 40;

/** A parsed, checked loader build. */
export interface ModLoaderArtifact {
  version: string;
  lib: Uint8Array;
  dex: Uint8Array;
  libSha256: string;
}

const fail = (message: string): never => {
  throw new PatchError(`mod loader: ${message}`, 'modLoaderUnavailable');
};

function isArm32So(b: Uint8Array): boolean {
  return b.length >= 52 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 && b[4] === 1 && b[5] === 1
    && b[16] === 3 && b[17] === 0 && b[18] === EM_ARM && b[19] === 0;
}

/**
 * Reads a loader zip: checks the pin (when given), `loader.json`, the SHA-256 and size of both files, that the
 * library is a 32-bit ARM shared object and that the dex is valid and only defines `com.blockheadsclub.modloader`.
 */
export function parseModLoaderZip(zipBytes: Uint8Array, pin: ModLoaderPin | null = MOD_LOADER_PIN): ModLoaderArtifact {
  if (pin && sha256HexSync(zipBytes) !== pin.sha256) fail(`the file does not match the pinned build ${pin.version} (SHA-256)`);
  let zip: ZipArchive;
  try { zip = readZip(zipBytes); } catch (e) { return fail(`not a zip (${(e as Error).message})`); }
  const file = (name: string): Uint8Array => {
    const e = getEntry(zip, name);
    return e ? peekData(e) : fail(`${name} is missing`);
  };
  let meta: { version?: unknown; listener?: unknown; libName?: unknown; lib?: { sha256?: unknown; size?: unknown }; dex?: { sha256?: unknown; size?: unknown } };
  try { meta = JSON.parse(new TextDecoder().decode(file('loader.json'))); } catch (e) {
    if (e instanceof PatchError) throw e;
    return fail('loader.json is not JSON');
  }
  if (typeof meta.version !== 'string' || semverToVersion(meta.version) === undefined) fail('loader.json has no major.minor.patch version');
  if (meta.listener !== MOD_LOADER_LISTENER || meta.libName !== MOD_LOADER_LIB) fail('loader.json does not describe this loader');
  if (pin && meta.version !== pin.version) fail(`loader.json says ${String(meta.version)}, the pin says ${pin.version}`);
  const lib = file('libbhmodloader.so'), dex = file('classes.dex');
  for (const [name, bytes, m] of [['libbhmodloader.so', lib, meta.lib], ['classes.dex', dex, meta.dex]] as const) {
    if (!m || sha256HexSync(bytes) !== m.sha256 || bytes.length !== m.size) fail(`${name} does not match loader.json`);
  }
  if (!isArm32So(lib)) fail('libbhmodloader.so is not a 32-bit ARM library');
  const problems = validateDex(dex);
  if (problems.length) fail(`classes.dex is not valid (${problems[0]})`);
  return { version: meta.version as string, lib, dex, libSha256: meta.lib!.sha256 as string };
}

let current: ModLoaderArtifact | null = null;

/** Sets the loader build that `apply` installs (the app loads and checks the pinned zip first). */
export function setModLoaderArtifact(a: ModLoaderArtifact | null): void {
  current = a;
}

/** The loader build set with {@link setModLoaderArtifact}. */
export function modLoaderArtifact(): ModLoaderArtifact | null {
  return current;
}

function metaValue(ctx: PatchContext, name: string): AxmlAttribute | undefined {
  const els = findElementsByName(ctx.manifest, 'meta-data', name);
  if (els.length !== 1) return undefined;
  const a = getAttr(els[0]!, 'value', undefined, ID_VALUE);
  return a?.valueType === ValueType.String ? a : undefined;
}

const words = (a: AxmlAttribute): string[] => a.stringValue!.split(/\s+/).filter(Boolean);
const DEX_NAME = (i: number): string => (i === 0 ? 'classes.dex' : `classes${i + 1}.dex`);

interface State {
  libs: AxmlAttribute;
  listeners: AxmlAttribute;
  /** Dex entry holding our classes, if any. */
  dexName?: string;
  /** True when that dex holds nothing but our classes (so it can be replaced on an update). */
  dexOwned: boolean;
  lib?: Uint8Array;
  done: { lib: boolean; libMeta: boolean; listenerMeta: boolean; dex: boolean };
}

function state(ctx: PatchContext): State | undefined {
  const libs = metaValue(ctx, LIBS_META), listeners = metaValue(ctx, LISTENERS_META);
  const set = openDexSet(ctx);
  if (!libs || !listeners || !set?.findClass(LIFECYCLE_LISTENER)) return undefined;
  const hit = set.findClass(MOD_LOADER_LISTENER_CLASS);
  const libEntry = getEntry(ctx.zip, MOD_LOADER_LIB_PATH);
  const lib = libEntry ? peekData(libEntry) : undefined;
  // The build the patch would install: the loaded zip, else the pin's hashes (the app lists patches before it loads the zip).
  const want = current ? { lib: current.libSha256, dex: sha256HexSync(current.dex) } : { lib: MOD_LOADER_PIN.libSha256, dex: MOD_LOADER_PIN.dexSha256 };
  return {
    libs, listeners,
    dexName: hit?.name,
    dexOwned: !!hit && hit.dex.classNames().every((c) => c.startsWith(MOD_LOADER_PACKAGE)),
    lib,
    done: {
      // with a build at hand (or pinned), an older installed loader counts as "not applied" (the patch updates it)
      lib: !!lib && sha256HexSync(lib) === want.lib,
      libMeta: words(libs).includes(MOD_LOADER_LIB),
      listenerMeta: words(listeners).includes(MOD_LOADER_LISTENER),
      dex: !!hit && sha256HexSync(peekData(getEntry(ctx.zip, hit.name)!)) === want.dex,
    },
  };
}

function detect(ctx: PatchContext): PatchStatus {
  const s = state(ctx);
  if (!s) return 'incompatible';
  if (s.dexName && !s.dexOwned) return 'incompatible';
  if (Object.values(s.done).every(Boolean)) return 'applied';
  // a loader file of another build is in the APK: that is an older (or different) install the patch replaces
  return (s.lib && !s.done.lib) || (s.dexName && !s.done.dex) ? 'outdated' : 'notApplied';
}

/** Writes the loader build into the APK: files not yet at that build are (re)written, manifest entries only added once. */
function install(ctx: PatchContext, want: PatchStatus): void {
  const a = current ?? fail('the loader files are not loaded');
  const status = detect(ctx);
  if (status !== want) throw new PatchError(`mod-loader cannot be applied (status: ${status})`, 'cannotApply', { status });
  const { libs, listeners, dexName, done } = state(ctx)!;
  if (!done.lib) setEntry(ctx.zip, { name: MOD_LOADER_LIB_PATH, data: a.lib.slice(), method: 0 });
  if (!done.libMeta) setAttrString(ctx.manifest, libs, [...words(libs), MOD_LOADER_LIB].join(' '));
  if (!done.listenerMeta) setAttrString(ctx.manifest, listeners, [...words(listeners), MOD_LOADER_LISTENER].join(' '));
  if (!done.libMeta || !done.listenerMeta) ctx.markManifestDirty();
  if (!done.dex) {
    const set = openDexSet(ctx)!;
    if (!dexName && set.names.some((n, i) => n !== DEX_NAME(i))) throw new PatchError('mod-loader: the APK dex files are not numbered consecutively', 'cannotApply');
    setEntry(ctx.zip, { name: dexName ?? DEX_NAME(set.names.length), data: a.dex.slice() });
  }
  ctx.log(`mod-loader: ${a.version} (${MOD_LOADER_LIB_PATH}, ${MOD_LOADER_LISTENER})`);
}

/**
 * "Add the mod loader" (optional). Adds `lib/armeabi-v7a/libbhmodloader.so` (stored, so it is page-aligned and
 * loads with `extractNativeLibs=false`), appends `bhmodloader` to the manifest meta-data `android.app.libs` (loaded
 * after libApplication on the game's main thread) and `com.blockheadsclub.modloader.Listener` to
 * `apportable.app.lifecycle_listeners`, and adds the loader's Java UI as the next `classesN.dex`. No game code is
 * changed: the loader hooks Objective-C methods at run time.
 *
 * The patch version is the loader build (`MOD_LOADER_PIN.version`, or the build set with setModLoaderArtifact) as one
 * integer, see semverToVersion. An older loader in the APK is `outdated`; `upgrade` replaces both files in place.
 */
export const modLoader: Patch = {
  id: 'mod-loader',
  get version(): number { return semverToVersion((current ?? MOD_LOADER_PIN).version)!; },
  versionLabel: versionToSemver,
  nameKey: 'patch.mod-loader.name',
  descriptionKey: 'patch.mod-loader.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE, versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  detect,
  installedVersion(ctx) {
    const lib = getEntry(ctx.zip, MOD_LOADER_LIB_PATH);
    const v = lib ? KNOWN_LOADER_LIBS[sha256HexSync(peekData(lib))] : undefined;
    return v === undefined ? undefined : semverToVersion(v);
  },
  apply(ctx) {
    install(ctx, 'notApplied');
  },
  upgrade(ctx) {
    install(ctx, 'outdated');
  },
};
