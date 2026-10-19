/** ELF32 little-endian section headers and symbol tables (what patch packs need to locate code by name). */
export interface ElfSection {
  name: string;
  type: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  entsize: number;
}
export const SHT_SYMTAB = 2;
export const SHT_DYNSYM = 11;
const SHT_NOBITS = 8;
const STT_FUNC = 2;

const cstr = (data: Uint8Array, at: number): string => {
  const end = data.indexOf(0, at);
  return new TextDecoder().decode(data.subarray(at, end < 0 ? data.length : end));
};

/** Section headers of an ELF32 file (empty when it has none); throws for anything else malformed. */
export function parseElfSections(data: Uint8Array): ElfSection[] {
  if (data.length < 52 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) throw new Error('not an ELF file');
  if (data[4] !== 1 || data[5] !== 1) throw new Error('only 32-bit little-endian ELF sections are supported');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const shoff = dv.getUint32(32, true), shentsize = dv.getUint16(46, true), shnum = dv.getUint16(48, true), shstrndx = dv.getUint16(50, true);
  if (shoff === 0 || shnum === 0) return [];
  if (shentsize < 40 || shoff + shentsize * shnum > data.length || shstrndx >= shnum) throw new Error('truncated ELF section headers');
  const raw = Array.from({ length: shnum }, (_, i) => {
    const p = shoff + i * shentsize;
    return {
      nameOff: dv.getUint32(p, true), type: dv.getUint32(p + 4, true), addr: dv.getUint32(p + 12, true), offset: dv.getUint32(p + 16, true),
      size: dv.getUint32(p + 20, true), link: dv.getUint32(p + 24, true), entsize: dv.getUint32(p + 36, true),
    };
  });
  const strtab = raw[shstrndx]!;
  return raw.map(({ nameOff, ...s }) => {
    if (s.type !== SHT_NOBITS && s.offset + s.size > data.length) throw new Error('ELF section out of bounds');
    return { ...s, name: nameOff < strtab.size ? cstr(data, strtab.offset + nameOff) : '' };
  });
}

/**
 * Address of a defined symbol, searched in .dynsym then .symtab. Thumb function addresses come without their low bit.
 * Undefined when the name is absent or only imported.
 */
export function findElfSymbol(data: Uint8Array, sections: ElfSection[], name: string): number | undefined {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (const type of [SHT_DYNSYM, SHT_SYMTAB]) {
    for (const sec of sections.filter((s) => s.type === type)) {
      const strs = sections[sec.link];
      if (!strs) continue;
      const step = sec.entsize || 16;
      for (let p = sec.offset; p + 16 <= sec.offset + sec.size; p += step) {
        const shndx = dv.getUint16(p + 14, true);
        const nameOff = dv.getUint32(p, true);
        if (shndx === 0 || nameOff >= strs.size || cstr(data, strs.offset + nameOff) !== name) continue;
        const value = dv.getUint32(p + 4, true);
        return (data[p + 12]! & 0xf) === STT_FUNC ? (value & ~1) >>> 0 : value;
      }
    }
  }
  return undefined;
}
