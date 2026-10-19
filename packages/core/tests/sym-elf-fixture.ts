import { CODE, buildElf } from './elf-fixture';

/**
 * buildElf() plus section headers, symbol tables and a tiny Objective-C class (`Foo`: `-[Foo bar:]` (Thumb) and
 * `+[Foo make]`) inside the RW segment. Addresses equal file offsets.
 */
export const OBJC = {
  classlist: 0x1140, cls: 0x1148, meta: 0x1160, ro: 0x1178, metaRo: 0x1190, methods: 0x11a8, metaMethods: 0x11bc,
  name: 0x11d0, sel: 0x11d4, metaSel: 0x11da, imp: CODE + 8, metaImp: CODE + 16,
} as const;
export const SYM = { func: CODE + 4, data: 0x1100, local: CODE + 12 } as const;

export interface SymElfOptions {
  /** Omit the class list section. */
  noClasslist?: boolean;
  /** Point .dynsym at a missing string table. */
  badLink?: boolean;
  /** Zero entsize for the symbol tables (defaults to 16). */
  zeroEntsize?: boolean;
}

export function buildSymElf(o: SymElfOptions = {}): Uint8Array {
  const base = buildElf();
  const enc = new TextEncoder();
  const put = (b: Uint8Array, at: number, ...words: number[]): void => {
    const dv = new DataView(b.buffer, b.byteOffset);
    words.forEach((w, i) => dv.setUint32(at + i * 4, w >>> 0, true));
  };
  // Objective-C metadata in the RW segment (0x1140..0x1200)
  put(base, OBJC.classlist, 0xffffffff, OBJC.cls);
  put(base, OBJC.cls, OBJC.meta, 0, 0, 0, OBJC.ro | 1);
  put(base, OBJC.meta, 0, 0, 0, 0, OBJC.metaRo);
  put(base, OBJC.ro, 0, 0, 0, 0, OBJC.name, OBJC.methods);
  put(base, OBJC.metaRo, 1, 0, 0, 0, OBJC.name, OBJC.metaMethods);
  put(base, OBJC.methods, 12 | 3, 1, OBJC.sel, 0, OBJC.imp | 1);
  put(base, OBJC.metaMethods, 12, 1, OBJC.metaSel, 0, OBJC.metaImp);
  base.set(enc.encode('Foo\0bar:\0\0make\0'), OBJC.name);

  // string tables
  const dynstr = enc.encode('\0my_func\0imported\0my_data\0');
  const strtab = enc.encode('\0local_fn\0');
  const shstr = enc.encode('\0.text\0.dynsym\0.dynstr\0.symtab\0.strtab\0__DATA, __objc_classlist\0.shstrtab\0.bss\0');
  const nameAt = (s: string): number => new TextDecoder().decode(shstr).indexOf(`\0${s}\0`) + 1;
  // symbols: [name, value, info, shndx]
  const syms = (entries: [number, number, number, number][]): Uint8Array => {
    const b = new Uint8Array(entries.length * 16), dv = new DataView(b.buffer);
    entries.forEach(([name, value, info, shndx], i) => {
      dv.setUint32(i * 16, name, true); dv.setUint32(i * 16 + 4, value, true); b[i * 16 + 12] = info; dv.setUint16(i * 16 + 14, shndx, true);
    });
    return b;
  };
  const dynsym = syms([[0, 0, 0, 0], [1, SYM.func | 1, 0x12, 1], [9, 0, 0x12, 0], [18, SYM.data | 1, 0x11, 2], [200, 0, 0x12, 1]]);
  const symtab = syms([[0, 0, 0, 0], [1, SYM.local, 0x02, 1]]);

  const parts: Uint8Array[] = [dynsym, dynstr, symtab, strtab, shstr];
  let off = base.length;
  const offs = parts.map((p) => { const at = off; off += p.length; return at; });
  const shoff = (off + 3) & ~3;
  // name, type, flags, addr, offset, size, link, info, align, entsize
  const es = o.zeroEntsize ? 0 : 16;
  const sections: number[][] = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [nameAt('.text'), 1, 6, CODE, CODE, 0x80, 0, 0, 4, 0],
    [nameAt('.dynsym'), 11, 2, 0, offs[0]!, dynsym.length, o.badLink ? 40 : 3, 1, 4, es],
    [nameAt('.dynstr'), 3, 2, 0, offs[1]!, dynstr.length, 0, 0, 1, 0],
    [nameAt('.symtab'), 2, 0, 0, offs[2]!, symtab.length, 5, 1, 4, es],
    [nameAt('.strtab'), 3, 0, 0, offs[3]!, strtab.length, 0, 0, 1, 0],
    [o.noClasslist ? nameAt('.bss') : nameAt('__DATA, __objc_classlist'), 1, 3, OBJC.classlist, OBJC.classlist, 8, 0, 0, 4, 0],
    [nameAt('.shstrtab'), 3, 0, 0, offs[4]!, shstr.length, 0, 0, 1, 0],
    [9999, 8, 3, 0x2000, 0xfffffff0, 0x100, 0, 0, 4, 0],
  ];
  const out = new Uint8Array(shoff + sections.length * 40);
  out.set(base);
  parts.forEach((p, i) => out.set(p, offs[i]!));
  sections.forEach((s, i) => put(out, shoff + i * 40, ...s));
  const dv = new DataView(out.buffer);
  dv.setUint32(32, shoff, true);
  dv.setUint16(46, 40, true);
  dv.setUint16(48, sections.length, true);
  dv.setUint16(50, 7, true);
  return out;
}
