/** Synthetic ELF fixtures for native patching tests. Layout (ELF32 ARM, little endian):
 *  LOAD R+X  0x0000..textEnd  (headers, code at 0x180, strings at 0x200)
 *  LOAD R+W  0x1000..0x1200   (dynamic at 0x1000, REL table at 0x1040, data at 0x1100) memsz 0x300
 *  DYNAMIC, NOTE (optional)
 */
export interface FixtureOptions {
  is64?: boolean;
  /** Where the executable segment ends; the slack up to 0x1000 is zero padding. */
  textEnd?: number;
  note?: boolean;
  /** Dynamic section kind: 'rel' (default), 'rela', 'none' (no PT_DYNAMIC), 'norel' (dynamic without DT_REL). */
  dynamic?: 'rel' | 'rela' | 'none' | 'norel' | 'badrel';
  machine?: number;
  /** Put non-zero junk into the padding at this offset. */
  junkAt?: number;
  /** Make the RW segment start in the same file page (offset textEnd + 8) to shrink the slack from the file side. */
  rwOffsetClose?: boolean;
}
export const CODE = 0x180;
export const STR = 0x200;
export const RW = 0x1000;
export const DATA = 0x1100;

export function buildElf(o: FixtureOptions = {}): Uint8Array {
  const is64 = !!o.is64, ehs = is64 ? 64 : 52, phs = is64 ? 56 : 32;
  const textEnd = o.textEnd ?? 0x300;
  const dyn = o.dynamic ?? 'rel';
  const phnum = 2 + (dyn === 'none' ? 0 : 1) + (o.note === false ? 0 : 1);
  const size = 0x1200;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1]);
  dv.setUint16(16, 3, true);
  dv.setUint16(18, o.machine ?? 40, true);
  if (is64) { dv.setBigUint64(32, BigInt(ehs), true); dv.setUint16(54, phs, true); dv.setUint16(56, phnum, true); }
  else { dv.setUint32(28, ehs, true); dv.setUint16(42, phs, true); dv.setUint16(44, phnum, true); }
  let n = 0;
  const ph = (type: number, offset: number, vaddr: number, filesz: number, memsz: number, flags: number, align: number): void => {
    const p = ehs + n++ * phs;
    if (is64) {
      dv.setUint32(p, type, true); dv.setUint32(p + 4, flags, true);
      dv.setBigUint64(p + 8, BigInt(offset), true); dv.setBigUint64(p + 16, BigInt(vaddr), true); dv.setBigUint64(p + 24, BigInt(vaddr), true);
      dv.setBigUint64(p + 32, BigInt(filesz), true); dv.setBigUint64(p + 40, BigInt(memsz), true); dv.setBigUint64(p + 48, BigInt(align), true);
    } else {
      dv.setUint32(p, type, true); dv.setUint32(p + 4, offset, true); dv.setUint32(p + 8, vaddr, true); dv.setUint32(p + 12, vaddr, true);
      dv.setUint32(p + 16, filesz, true); dv.setUint32(p + 20, memsz, true); dv.setUint32(p + 24, flags, true); dv.setUint32(p + 28, align, true);
    }
  };
  ph(1, 0, 0, textEnd, textEnd, 5, 0x1000);
  ph(1, o.rwOffsetClose ? textEnd + 8 : RW, RW, 0x200, 0x300, 6, 0x1000);
  if (dyn !== 'none') ph(2, RW, RW, 0x40, 0x40, 6, 4);
  if (o.note !== false) ph(4, 0x34, 0x34, 0x20, 0x20, 4, 4);
  // code words and strings
  for (let i = 0; i < 16; i++) dv.setUint32(CODE + i * 4, 0xe1a00000 + i, true);
  b.set(new TextEncoder().encode('hello world\0'), STR);
  b.set(new TextEncoder().encode('short\0'), STR + 0x20);
  if (o.junkAt !== undefined) b[o.junkAt] = 0xaa;
  // dynamic + REL table
  if (dyn !== 'none') {
    const tags: [number, number][] =
      dyn === 'rel' ? [[17, RW + 0x40], [18, 24], [0, 0]]
      : dyn === 'badrel' ? [[17, 0x5000], [18, 24], [0, 0]]
      : dyn === 'rela' ? [[17, RW + 0x40], [18, 24], [7, RW + 0x40], [0, 0]]
      : [[0, 0]];
    tags.forEach(([t, v], i) => { dv.setUint32(RW + i * 8, t, true); dv.setUint32(RW + i * 8 + 4, v, true); });
    [[DATA + 8, 23], [DATA + 0x18, 23], [DATA + 0x28, 2]].forEach(([off, info], i) => {
      dv.setUint32(RW + 0x40 + i * 8, off!, true); dv.setUint32(RW + 0x40 + i * 8 + 4, info!, true);
    });
  }
  // two CFString-like objects {isa, flags, data, length} pointing at the strings
  const cf = (at: number, str: number, len: number): void => {
    dv.setUint32(at, 0, true); dv.setUint32(at + 4, 0x7c8, true); dv.setUint32(at + 8, str, true); dv.setUint32(at + 12, len, true);
  };
  cf(DATA, STR, 11);
  cf(DATA + 0x10, STR, 11);
  cf(DATA + 0x20, STR + 0x20, 5);
  return b;
}
