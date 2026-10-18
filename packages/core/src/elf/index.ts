/** Minimal ELF32/ELF64 little-endian reader: just enough to map virtual addresses to file offsets. */
export interface ElfSegment {
  type: number;
  offset: number;
  vaddr: number;
  filesz: number;
  memsz: number;
  /** p_flags (1 = X, 2 = W, 4 = R). */
  flags: number;
  align: number;
  /** File offset of this program header entry. */
  phOffset: number;
}
export const PT_LOAD = 1;
export const PT_DYNAMIC = 2;
export const PT_NOTE = 4;
export const PF_X = 1;
export const PF_W = 2;
export const PF_R = 4;

export function parseElfSegments(data: Uint8Array): ElfSegment[] {
  if (data.length < 52 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) throw new Error('not an ELF file');
  const is64 = data[4] === 2;
  if (data[5] !== 1) throw new Error('only little-endian ELF is supported');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const phoff = is64 ? Number(dv.getBigUint64(32, true)) : dv.getUint32(28, true);
  const phentsize = dv.getUint16(is64 ? 54 : 42, true);
  const phnum = dv.getUint16(is64 ? 56 : 44, true);
  if (phoff + phentsize * phnum > data.length) throw new Error('truncated ELF program headers');
  const out: ElfSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (is64)
      out.push({
        type: dv.getUint32(p, true), offset: Number(dv.getBigUint64(p + 8, true)), vaddr: Number(dv.getBigUint64(p + 16, true)),
        filesz: Number(dv.getBigUint64(p + 32, true)), memsz: Number(dv.getBigUint64(p + 40, true)),
        flags: dv.getUint32(p + 4, true), align: Number(dv.getBigUint64(p + 48, true)), phOffset: p,
      });
    else
      out.push({
        type: dv.getUint32(p, true), offset: dv.getUint32(p + 4, true), vaddr: dv.getUint32(p + 8, true),
        filesz: dv.getUint32(p + 16, true), memsz: dv.getUint32(p + 20, true),
        flags: dv.getUint32(p + 24, true), align: dv.getUint32(p + 28, true), phOffset: p,
      });
  }
  return out;
}

/** File offset backing `vaddr` (PT_LOAD, file-backed bytes only), or undefined. */
export function vaddrToFileOffset(segments: ElfSegment[], vaddr: number, length = 1): number | undefined {
  for (const s of segments)
    if (s.type === PT_LOAD && vaddr >= s.vaddr && vaddr + length <= s.vaddr + s.filesz) return s.offset + (vaddr - s.vaddr);
  return undefined;
}
