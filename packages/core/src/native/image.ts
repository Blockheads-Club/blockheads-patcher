import { PF_R, PF_X, PT_DYNAMIC, PT_LOAD, PT_NOTE, parseElfSegments, type ElfSegment } from '../elf';

export class ElfImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElfImageError';
  }
}

const PAGE = 0x1000;
const alignUp = (v: number, a: number): number => Math.ceil(v / a) * a;
const DT_NULL = 0;
const DT_REL = 17;
const DT_RELSZ = 18;
const DT_RELA = 7;
const R_ARM_RELATIVE = 23;
const EM_ARM = 40;

/** A mutable copy of an ELF library addressed by virtual address, with simple allocation of new executable space. */
export class ElfImage {
  data: Uint8Array;
  readonly segments: ElfSegment[];
  private readonly is64: boolean;

  /** `copy: false` shares the buffer (read-only use: never call write/allocate on such an image). */
  constructor(bytes: Uint8Array, copy = true) {
    this.segments = parseElfSegments(bytes);
    this.data = copy ? bytes.slice() : bytes;
    this.is64 = bytes[4] === 2;
  }

  private view(): DataView {
    return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
  private get machine(): number {
    return this.view().getUint16(18, true);
  }

  /** File offset of `length` bytes at `vaddr`, if fully backed by file bytes of one PT_LOAD. */
  offsetOf(vaddr: number, length = 1): number | undefined {
    for (const s of this.segments) {
      if (s.type !== PT_LOAD || vaddr < s.vaddr || vaddr + length > s.vaddr + s.filesz) continue;
      const o = s.offset + (vaddr - s.vaddr);
      return o + length <= this.data.length ? o : undefined;
    }
    return undefined;
  }
  read(vaddr: number, length: number): Uint8Array | undefined {
    const o = this.offsetOf(vaddr, length);
    return o === undefined ? undefined : this.data.subarray(o, o + length);
  }
  readU32(vaddr: number): number | undefined {
    const o = this.offsetOf(vaddr, 4);
    return o === undefined ? undefined : this.view().getUint32(o, true);
  }
  /** NUL-terminated string at `vaddr` (without the terminator), or undefined. */
  readCString(vaddr: number): string | undefined {
    const o = this.offsetOf(vaddr, 1);
    if (o === undefined) return undefined;
    const end = this.data.indexOf(0, o);
    return end < 0 ? undefined : new TextDecoder().decode(this.data.subarray(o, end));
  }
  write(vaddr: number, bytes: ArrayLike<number>): void {
    const o = this.offsetOf(vaddr, bytes.length);
    if (o === undefined) throw new ElfImageError(`address 0x${vaddr.toString(16)} (+${bytes.length}) is not backed by the file`);
    this.data.set(bytes as ArrayLike<number>, o);
  }
  writeU32(vaddr: number, value: number): void {
    this.write(vaddr, [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
  }

  /**
   * True when the 32-bit ARM word at `vaddr` is covered by an R_ARM_RELATIVE relocation (so the loader adds the load
   * bias to the stored address and the word may be re-pointed by writing a new link-time address into it).
   */
  hasRelativeReloc(vaddr: number): boolean {
    if (this.is64 || this.machine !== EM_ARM) return false;
    const dyn = this.segments.find((s) => s.type === PT_DYNAMIC);
    if (!dyn || dyn.offset + dyn.filesz > this.data.length) return false;
    const dv = this.view();
    let rel = 0, relsz = 0, hasRela = false;
    for (let p = dyn.offset; p + 8 <= dyn.offset + dyn.filesz; p += 8) {
      const tag = dv.getUint32(p, true);
      const val = dv.getUint32(p + 4, true);
      if (tag === DT_NULL) break;
      if (tag === DT_REL) rel = val;
      else if (tag === DT_RELSZ) relsz = val;
      else if (tag === DT_RELA) hasRela = true;
    }
    if (hasRela || rel === 0) return false;
    const start = this.offsetOf(rel, relsz);
    if (start === undefined) return false;
    for (let p = start; p + 8 <= start + relsz; p += 8)
      if (dv.getUint32(p, true) === vaddr && (dv.getUint32(p + 4, true) & 0xff) === R_ARM_RELATIVE) return true;
    return false;
  }

  /** Executable PT_LOAD page tails: file-backed bytes after the segment that the loader maps anyway. */
  private slacks(): { seg: ElfSegment; length: number }[] {
    const loads = this.segments.filter((s) => s.type === PT_LOAD);
    const out: { seg: ElfSegment; length: number }[] = [];
    for (const s of loads) {
      if (!(s.flags & PF_X) || s.memsz !== s.filesz) continue;
      const page = s.align >= PAGE && (s.align & (s.align - 1)) === 0 ? s.align : PAGE;
      const start = s.vaddr + s.filesz;
      const fileStart = s.offset + s.filesz;
      let length = Math.min(alignUp(start, page) - start, this.data.length - fileStart);
      for (const o of loads) {
        if (o === s) continue;
        if (o.vaddr >= start) length = Math.min(length, o.vaddr - start);
        if (o.offset >= fileStart) length = Math.min(length, o.offset - fileStart);
      }
      if (length > 0) out.push({ seg: s, length });
    }
    return out;
  }

  private appendedSegment(): ElfSegment | undefined {
    const loads = this.segments.filter((s) => s.type === PT_LOAD);
    const top = loads.sort((a, b) => b.vaddr + b.memsz - (a.vaddr + a.memsz))[0]!;
    return (top.flags & PF_X) && top.memsz === top.filesz && top.offset + top.filesz === this.data.length ? top : undefined;
  }

  private setSegment(s: ElfSegment, fields: Partial<Pick<ElfSegment, 'type' | 'offset' | 'vaddr' | 'filesz' | 'memsz' | 'flags' | 'align'>>): void {
    Object.assign(s, fields);
    const dv = this.view();
    const p = s.phOffset;
    if (this.is64) {
      dv.setUint32(p, s.type, true); dv.setUint32(p + 4, s.flags, true);
      dv.setBigUint64(p + 8, BigInt(s.offset), true); dv.setBigUint64(p + 16, BigInt(s.vaddr), true); dv.setBigUint64(p + 24, BigInt(s.vaddr), true);
      dv.setBigUint64(p + 32, BigInt(s.filesz), true); dv.setBigUint64(p + 40, BigInt(s.memsz), true); dv.setBigUint64(p + 48, BigInt(s.align), true);
    } else {
      dv.setUint32(p, s.type, true); dv.setUint32(p + 4, s.offset, true); dv.setUint32(p + 8, s.vaddr, true); dv.setUint32(p + 12, s.vaddr, true);
      dv.setUint32(p + 16, s.filesz, true); dv.setUint32(p + 20, s.memsz, true); dv.setUint32(p + 24, s.flags, true); dv.setUint32(p + 28, s.align, true);
    }
  }

  private grow(extra: number): void {
    const next = new Uint8Array(this.data.length + extra);
    next.set(this.data);
    this.data = next;
  }

  /**
   * Reserves `size` zero bytes of readable, executable memory and returns their virtual address. Uses unused page-tail
   * padding of an existing executable segment when it is large enough; otherwise appends a new R+X PT_LOAD at the end of
   * the file (by re-purposing the PT_NOTE program header), or extends such a segment created earlier.
   */
  allocate(size: number, align = 4): number {
    for (const { seg, length } of this.slacks()) {
      const start = alignUp(seg.vaddr + seg.filesz, align);
      const gap = start - (seg.vaddr + seg.filesz);
      if (gap + size > length) continue;
      const fileStart = seg.offset + seg.filesz;
      if (!this.data.subarray(fileStart, fileStart + gap + size).every((b) => b === 0)) continue;
      this.setSegment(seg, { filesz: start + size - seg.vaddr, memsz: start + size - seg.vaddr });
      return start;
    }
    let seg = this.appendedSegment();
    if (!seg) {
      const note = this.segments.find((s) => s.type === PT_NOTE);
      if (!note) throw new ElfImageError('no free padding and no PT_NOTE program header to turn into an executable segment');
      const loads = this.segments.filter((s) => s.type === PT_LOAD);
      const vaddr = alignUp(Math.max(...loads.map((s) => s.vaddr + s.memsz)), PAGE);
      const offset = alignUp(this.data.length, PAGE);
      this.grow(offset - this.data.length);
      this.setSegment(note, { type: PT_LOAD, offset, vaddr, filesz: 0, memsz: 0, flags: PF_R | PF_X, align: PAGE });
      seg = note;
    }
    const start = alignUp(seg.vaddr + seg.filesz, align);
    const end = start + size;
    this.grow(end - (seg.vaddr + seg.filesz));
    this.setSegment(seg, { filesz: end - seg.vaddr, memsz: end - seg.vaddr });
    return start;
  }
}
