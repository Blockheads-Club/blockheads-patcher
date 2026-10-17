import { parseElfSegments, vaddrToFileOffset } from '../elf';
import { sha256HexSync } from '../elf/sha256';
import { getEntry, setEntry } from '../zip';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const BX_LR = 0xe12fff1e;

export interface NativeStubSpec {
  id: string;
  packageName: string;
  versionCode: number;
  versionName: string;
  libPath: string;
  /** SHA-256 (hex) of the original library entry content. */
  libSha256: string;
  /** Virtual addresses of functions whose first instruction (expected `original`) is replaced by `bx lr`. */
  addresses: number[];
  original: number;
}

/** Builds a patch that turns the given ARM functions into immediate returns after verifying lib hash and original words. */
export function makeNativeStubPatch(spec: NativeStubSpec): Patch {
  const locate = (ctx: PatchContext): { data: Uint8Array; offsets: number[] } | undefined => {
    const e = getEntry(ctx.zip, spec.libPath);
    if (!e) return undefined;
    try {
      const segs = parseElfSegments(e.data);
      const offsets = spec.addresses.map((a) => vaddrToFileOffset(segs, a, 4));
      if (offsets.some((o) => o === undefined || o + 4 > e.data.length)) return undefined;
      return { data: e.data, offsets: offsets as number[] };
    } catch {
      return undefined;
    }
  };
  const word = (d: Uint8Array, o: number): number => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
  const detect = (ctx: PatchContext): PatchStatus => {
    if (ctx.info.versionCode !== spec.versionCode) return 'incompatible';
    const loc = locate(ctx);
    if (!loc) return 'incompatible';
    const words = loc.offsets.map((o) => word(loc.data, o));
    if (words.every((w) => w === BX_LR)) return 'applied';
    if (words.every((w) => w === spec.original) && sha256HexSync(loc.data) === spec.libSha256) return 'notApplied';
    return 'incompatible';
  };
  return {
    id: spec.id,
    version: 1,
    nameKey: `patch.${spec.id}.name`,
    descriptionKey: `patch.${spec.id}.description`,
    appliesTo: { packageName: spec.packageName, versionCode: { min: spec.versionCode, max: spec.versionCode }, versionNames: [spec.versionName] },
    detect,
    apply(ctx) {
      const status = detect(ctx);
      if (status !== 'notApplied') throw new PatchError(`${spec.id} cannot be applied (status: ${status})`, 'cannotApply', { status });
      const loc = locate(ctx)!;
      const out = loc.data.slice();
      const dv = new DataView(out.buffer);
      for (const o of loc.offsets) dv.setUint32(o, BX_LR, true);
      setEntry(ctx.zip, { name: spec.libPath, data: out });
      ctx.log(`${spec.id}: stubbed ${spec.addresses.length} functions in ${spec.libPath}`);
    },
  };
}

/**
 * Blockheads 1.7.6 only: the Play billing product list reaches the 4 IAP response handlers, which load a system
 * font through an Apportable path that crashes on Android 10+ (SIGSEGV in CGFontCopyName). The handlers become no-ops.
 */
export const fixIapStoreFontCrash: Patch = makeNativeStubPatch({
  id: 'fix-iap-store-font-crash',
  packageName: 'com.noodlecake.blockheads',
  versionCode: 1564553369,
  versionName: '1.7.6',
  libPath: 'lib/armeabi-v7a/libApplication.so',
  libSha256: '733d821027d69de329d0ba171df2e6013d612edf5a4d327badd001acc30b94c7',
  addresses: [0xb79ee0, 0xb0f5cc, 0xb5d558, 0xd33974],
  original: 0xe92d4df0,
});
