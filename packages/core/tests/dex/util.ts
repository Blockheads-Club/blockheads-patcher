import { adler32, sha1 } from '../../src/dex/index';
import { ByteReader as BR } from '../../src/dex/bytes';

/** Recomputes signature and checksum so a mutation is the only thing the validator can object to. */
export function reseal(b: Uint8Array): Uint8Array {
  b.set(sha1(b.subarray(32)), 12);
  new DataView(b.buffer, b.byteOffset).setUint32(8, adler32(b.subarray(12)), true);
  return b;
}

export const u32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
export const setU32 = (b: Uint8Array, at: number, v: number): void => new DataView(b.buffer, b.byteOffset).setUint32(at, v, true);
export const setU16 = (b: Uint8Array, at: number, v: number): void => new DataView(b.buffer, b.byteOffset).setUint16(at, v, true);

/** Header fields by name. */
export const H = { mapOff: 0x34, nStr: 0x38, oStr: 0x3c, nType: 0x40, oType: 0x44, nProto: 0x48, oProto: 0x4c, nField: 0x50, oField: 0x54, nMeth: 0x58, oMeth: 0x5c, nCls: 0x60, oCls: 0x64 } as const;

export interface Located { classDef: number; classData: number; methods: { idx: number; flags: number; code: number; at: number }[] }

/** Finds class_data and code item offsets of class `i` (class_def order). */
export function locate(b: Uint8Array, i: number): Located {
  const classDef = u32(b, H.oCls) + 32 * i;
  const classData = u32(b, classDef + 24);
  const methods: Located['methods'] = [];
  if (classData) {
    const r = new BR(b, classData);
    const [ns, ni, nd, nv] = [r.uleb(), r.uleb(), r.uleb(), r.uleb()];
    for (let k = 0; k < ns + ni; k++) { r.uleb(); r.uleb(); }
    let idx = 0;
    for (let k = 0; k < nd + nv; k++) {
      if (k === nd) idx = 0;
      idx += r.uleb();
      const flags = r.uleb(), at = r.pos, code = r.uleb();
      methods.push({ idx, flags, code, at });
    }
  }
  return { classDef, classData, methods };
}
