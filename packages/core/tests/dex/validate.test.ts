import { describe, it, expect } from 'vitest';
import { adler32, validateDex } from '../../src/dex';
import { richDex } from './samples';
import { H, locate, reseal, setU16, setU32, u32 } from './util';

const swap = (b: Uint8Array, a: number, c: number, n: number): void => { const t = b.slice(a, a + n); b.copyWithin(a, c, c + n); b.set(t, c); };
const sid = (b: Uint8Array, i: number): number => u32(b, H.oStr) + 4 * i;
const tid = (b: Uint8Array, i: number): number => u32(b, H.oType) + 4 * i;
const pid = (b: Uint8Array, i: number): number => u32(b, H.oProto) + 12 * i;
const fid = (b: Uint8Array, i: number): number => u32(b, H.oField) + 8 * i;
const mid = (b: Uint8Array, i: number): number => u32(b, H.oMeth) + 8 * i;
const cdef = (b: Uint8Array, i: number): number => u32(b, H.oCls) + 32 * i;
const mapEntry = (b: Uint8Array, type: number): number => {
  const base = u32(b, H.mapOff);
  for (let i = 0; i < u32(b, base); i++) if (new DataView(b.buffer, b.byteOffset).getUint16(base + 4 + 12 * i, true) === type) return base + 4 + 12 * i;
  throw new Error('no such map entry');
};
/** Code item of method `name` in class 0 (Base). */
const codeOf = (b: Uint8Array, nth: number): number => locate(b, 0).methods[nth]!.code;

const cases: [string, (b: Uint8Array) => void, string, boolean?][] = [
  ['bad magic', (b) => { b[1] = 0; }, 'bad magic or version'],
  ['file size', (b) => setU32(b, 0x20, b.length + 1), 'file_size'],
  ['header size', (b) => setU32(b, 0x24, 0x80), 'bad header_size'],
  ['endian tag', (b) => setU32(b, 0x28, 1), 'endian'],
  ['checksum', (b) => { b[0x90]! ^= 1; }, 'checksum mismatch', false],
  ['signature', (b) => { b[13]! ^= 1; setU32(b, 8, adler32(b.subarray(12))); }, 'signature mismatch', false],
  ['map offset beyond the file', (b) => setU32(b, H.mapOff, 0x7ffffff0), 'unreadable'],
  ['map item out of order', (b) => { const e = mapEntry(b, 2); setU32(b, e + 8, 0); }, 'out of order'],
  ['map item beyond file', (b) => setU32(b, mapEntry(b, 0x2002) + 8, 0x7ffffff0), 'offset out of file'],
  ['duplicate map item', (b) => setU16(b, mapEntry(b, 3), 2), 'duplicate map item'],
  ['map disagrees with header', (b) => setU32(b, H.nField, u32(b, H.nField) + 1), 'disagrees with the header'],
  ['map does not list itself', (b) => setU32(b, mapEntry(b, 0x1000) + 8, 0), 'does not point at itself'],
  ['string order', (b) => swap(b, sid(b, 3), sid(b, 4), 4), 'not sorted/unique'],
  ['string length prefix', (b) => { b[u32(b, sid(b, 2))]! += 1; }, 'length prefix mismatch'],
  ['type descriptor index', (b) => setU32(b, tid(b, 1), 99999), 'bad descriptor index'],
  ['type order', (b) => swap(b, tid(b, 2), tid(b, 3), 4), 'not sorted/unique'],
  ['type descriptor syntax', (b) => { const s = u32(b, tid(b, 0)); b[u32(b, sid(b, s)) + 1] = 0x21; }, 'malformed descriptor'],
  ['proto shorty', (b) => setU32(b, pid(b, 0), u32(b, pid(b, 1))), 'shorty'],
  ['proto index', (b) => setU32(b, pid(b, 0) + 4, 99999), 'bad index'],
  ['proto order', (b) => swap(b, pid(b, 0), pid(b, 1), 12), 'not sorted/unique'],
  ['proto param list alignment', (b) => { let i = 0; while (!u32(b, pid(b, i) + 8)) i++; setU32(b, pid(b, i) + 8, u32(b, pid(b, i) + 8) + 2); }, 'not 4-aligned'],
  ['type list entry', (b) => { let i = 0; while (!u32(b, pid(b, i) + 8)) i++; setU16(b, u32(b, pid(b, i) + 8) + 4, 9999); }, 'type index out of range'],
  ['field name', (b) => setU32(b, fid(b, 0) + 4, 99999), 'field 0: index out of range'],
  ['field order', (b) => swap(b, fid(b, 1), fid(b, 2), 8), 'field 2 not sorted'],
  ['method type index', (b) => setU16(b, mid(b, 0) + 2, 9999), 'method 0: index out of range'],
  ['method order', (b) => swap(b, mid(b, 4), mid(b, 5), 8), 'method 5 not sorted'],
  ['duplicate class', (b) => setU32(b, cdef(b, 0), u32(b, cdef(b, 1))), 'duplicate definition'],
  ['class type', (b) => setU32(b, cdef(b, 0), 9999), 'class 0: bad type'],
  ['superclass out of range', (b) => setU32(b, cdef(b, 1) + 8, 9999), 'bad superclass/interface'],
  ['superclass defined later', (b) => swap(b, cdef(b, 0), cdef(b, 1), 32), 'defined later'],
  ['class data offset beyond file', (b) => setU32(b, cdef(b, 0) + 24, 0x7ffffff0), 'class_data offset out of file'],
  ['member order', (b) => { b[locate(b, 0).classData + 6] = 0; }, 'not ascending'],
  ['member index', (b) => { b[locate(b, 0).classData + 4] = 0x7f; }, 'member index out of range'],
  ['member of another class', (b) => {
    const baseType = u32(b, cdef(b, 0));
    let k = 0;
    while (new DataView(b.buffer, b.byteOffset).getUint16(fid(b, k), true) === baseType) k++;
    b[locate(b, 0).classData + 4] = k;
  }, 'belongs to another class'],
  ['code alignment', (b) => { const at = locate(b, 0).methods[0]!.at; b[at]! ^= 2; }, 'not 4-aligned'],
  ['ins greater than registers', (b) => setU16(b, codeOf(b, 0) + 2, 99), 'ins > registers'],
  ['debug offset', (b) => setU32(b, codeOf(b, 0) + 8, 0x7ffffff0), 'debug_info offset out of file'],
  ['index out of range in code', (b) => setU16(b, codeOf(b, 2) + 16 + 2, 9999), 'index out of range'],
  ['branch leaves the method', (b) => { b[codeOf(b, 2) + 16 + 27 * 2 + 1] = 0x7f; }, 'leaves the method'],
  ['catch type', (b) => { b[codeOf(b, 2) + 16 + 126 + 2 + 16 + 2] = 0x7f; }, 'catch type out of range'],
  ['catch address', (b) => { b[codeOf(b, 2) + 16 + 126 + 2 + 16 + 3] = 0x7e; }, 'catch address is not an instruction'],
  ['catch-all address', (b) => { b[codeOf(b, 2) + 16 + 126 + 2 + 16 + 7] = 0x7e; }, 'catch-all address is not an instruction'],
  ['try range', (b) => setU16(b, codeOf(b, 2) + 16 + 126 + 2 + 4, 9999), 'bad try range'],
  ['try handler offset', (b) => setU16(b, codeOf(b, 2) + 16 + 126 + 2 + 6, 0x55), 'handler offset invalid'],
];

describe('validateDex', () => {
  it('accepts a well-formed dex', () => expect(validateDex(richDex())).toEqual([]));
  it('rejects a file shorter than the header', () => expect(validateDex(new Uint8Array(10))).toEqual(['file shorter than the header']));
  it.each(cases)('reports: %s', (_name, mutate, expected, seal = true) => {
    const b = richDex().slice();
    mutate(b);
    const errors = validateDex(seal ? reseal(b) : b);
    expect(errors.join('\n')).toContain(expected);
  });
  it('stops after 50 findings', () => {
    const b = richDex().slice();
    for (let i = 0; i < u32(b, H.nStr); i++) setU32(b, sid(b, i), u32(b, sid(b, 0)));
    expect(validateDex(reseal(b)).length).toBe(50);
  });
});
