import { describe, it, expect } from 'vitest';
import { ElfImage, ElfImageError } from '../src/native';
import { buildElf, DATA, STR } from './elf-fixture';

describe('ElfImage access', () => {
  it('reads and writes by virtual address', () => {
    const src = buildElf();
    const img = new ElfImage(src);
    expect(img.read(STR, 5)).toEqual(new TextEncoder().encode('hello'));
    expect(img.read(0x9000, 4)).toBeUndefined();
    expect(img.readU32(DATA + 8)).toBe(STR);
    expect(img.readU32(0x9000)).toBeUndefined();
    expect(img.readCString(STR)).toBe('hello world');
    expect(img.readCString(0x9000)).toBeUndefined();
    img.write(STR, [0x48]);
    img.writeU32(DATA + 12, 0x01020304);
    expect(img.readCString(STR)).toBe('Hello world');
    expect(img.readU32(DATA + 12)).toBe(0x01020304);
    expect(src[STR]).toBe(0x68); // the input is copied
    expect(() => img.write(0x9000, [1])).toThrow(ElfImageError);
  });
  it('shares the buffer when copy is false', () => {
    const src = buildElf();
    const img = new ElfImage(src, false);
    expect(img.data).toBe(src);
  });
  it('treats an unterminated string as missing', () => {
    const src = buildElf();
    src.fill(0x41, 0x1100, 0x1200);
    expect(new ElfImage(src).readCString(DATA)).toBeUndefined();
  });
  it('rejects segments that run past the end of the file', () => {
    const img = new ElfImage(buildElf().subarray(0, 0x1100));
    expect(img.offsetOf(0x10f0, 0x20)).toBeUndefined();
  });
});

describe('hasRelativeReloc', () => {
  it('finds R_ARM_RELATIVE entries only', () => {
    const img = new ElfImage(buildElf());
    expect(img.hasRelativeReloc(DATA + 8)).toBe(true);
    expect(img.hasRelativeReloc(DATA + 0x18)).toBe(true);
    expect(img.hasRelativeReloc(DATA + 0x28)).toBe(false); // a different relocation type
    expect(img.hasRelativeReloc(DATA)).toBe(false);
  });
  it('refuses unsupported layouts', () => {
    expect(new ElfImage(buildElf({ dynamic: 'none' })).hasRelativeReloc(DATA + 8)).toBe(false);
    expect(new ElfImage(buildElf({ dynamic: 'rela' })).hasRelativeReloc(DATA + 8)).toBe(false);
    expect(new ElfImage(buildElf({ dynamic: 'norel' })).hasRelativeReloc(DATA + 8)).toBe(false);
    expect(new ElfImage(buildElf({ dynamic: 'badrel' })).hasRelativeReloc(DATA + 8)).toBe(false);
    expect(new ElfImage(buildElf({ is64: true })).hasRelativeReloc(DATA + 8)).toBe(false);
    expect(new ElfImage(buildElf({ machine: 3 })).hasRelativeReloc(DATA + 8)).toBe(false);
    const cut = buildElf();
    expect(new ElfImage(cut.subarray(0, 0x1010)).hasRelativeReloc(DATA + 8)).toBe(false);
  });
});

describe('allocate', () => {
  it('uses page-tail padding and chains allocations', () => {
    const img = new ElfImage(buildElf());
    const a = img.allocate(10);
    expect(a).toBe(0x300);
    img.write(a, new Array(10).fill(1));
    const b = img.allocate(8, 8);
    expect(b).toBe(0x310);
    const text = img.segments[0]!;
    expect(text.filesz).toBe(0x318);
    expect(text.memsz).toBe(0x318);
    expect(img.data.length).toBe(0x1200); // nothing appended
    expect(img.readU32(0x310)).toBe(0);
  });
  it('skips padding that is not zero or too small and appends a segment over PT_NOTE', () => {
    const dirty = new ElfImage(buildElf({ junkAt: 0x304 }));
    const at = dirty.allocate(16);
    const note = dirty.segments.find((s) => s.type === 1 && s.vaddr === at)!;
    expect(note.flags).toBe(5);
    expect(at % 0x1000).toBe(0);
    expect(at).toBeGreaterThanOrEqual(0x1300);
    expect(dirty.data.length).toBe(note.offset + 16);
    dirty.write(at, [1, 2, 3]);
    // a second allocation extends the same segment
    const second = dirty.allocate(5, 8);
    expect(second).toBe(at + 16);
    expect(dirty.data.length).toBe(note.offset + 16 + 5);
  });
  it('appends when the padding is smaller than the request', () => {
    const img = new ElfImage(buildElf({ textEnd: 0xff8 }));
    const at = img.allocate(0x10);
    expect(at).toBeGreaterThanOrEqual(0x1300);
  });
  it('is limited by the next segment in the file and in memory', () => {
    const close = new ElfImage(buildElf({ rwOffsetClose: true }));
    // RW file data starts 8 bytes after the text segment end: no room for 16 bytes
    expect(close.allocate(16)).toBeGreaterThanOrEqual(0x1300);
    const ok = new ElfImage(buildElf({ rwOffsetClose: true }));
    expect(ok.allocate(8)).toBe(0x300);
  });
  it('leaves an alignment gap that must be zero', () => {
    const img = new ElfImage(buildElf({ textEnd: 0x2fd }));
    expect(img.allocate(4, 4)).toBe(0x300);
  });
  it('works on ELF64 images', () => {
    const img = new ElfImage(buildElf({ is64: true, junkAt: 0x304 }));
    const at = img.allocate(8);
    expect(at).toBeGreaterThanOrEqual(0x1300);
    const seg = new ElfImage(img.data).segments.find((s) => s.vaddr === at)!;
    expect(seg.filesz).toBe(8);
    expect(seg.type).toBe(1);
    const slack = new ElfImage(buildElf({ is64: true }));
    expect(slack.allocate(4)).toBe(0x300);
  });
  it('fails without padding and without PT_NOTE', () => {
    const img = new ElfImage(buildElf({ junkAt: 0x304, note: false }));
    expect(() => img.allocate(16)).toThrow(ElfImageError);
  });
  it('honours a small p_align by assuming 4 KiB pages', () => {
    const src = buildElf();
    new DataView(src.buffer).setUint32(52 + 28, 4, true);
    expect(new ElfImage(src).allocate(4)).toBe(0x300);
  });
});
