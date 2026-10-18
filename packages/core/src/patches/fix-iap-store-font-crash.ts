import { makeNativePatch } from '../native';
import type { Patch } from './types';

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
  return makeNativePatch({
    id: spec.id, packageName: spec.packageName, libPath: spec.libPath,
    versions: [{
      versionCode: spec.versionCode, versionName: spec.versionName, libSha256: spec.libSha256,
      edits: spec.addresses.map((vaddr) => ({ kind: 'arm' as const, vaddr, original: [spec.original], replacement: [BX_LR] })),
    }],
  });
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
