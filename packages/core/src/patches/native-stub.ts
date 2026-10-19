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

