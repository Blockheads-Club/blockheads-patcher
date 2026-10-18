import { describe, it, expect } from 'vitest';
import { AsmError, assemble, decodeArmBranch, encodeArmB, measure, type CodeBlock } from '../src/native';

const words = (b: Uint8Array): number[] => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: b.length / 4 }, (_, i) => dv.getUint32(i * 4, true));
};

describe('assemble', () => {
  it('emits raw items, labels, alignment and data words', () => {
    const block: CodeBlock = {
      mode: 'arm',
      items: [
        { op: 'arm', words: [0xe1a00000] },
        { op: 'label', name: 'a' },
        { op: 'bytes', bytes: [1, 2, 3] },
        { op: 'align', to: 4 },
        { op: 'align', to: 4 },
        { op: 'word', value: 0xdeadbeef },
        { op: 'wordRel', target: 'a', from: 0x1000, add: 8 },
      ],
    };
    const out = assemble(block, 0x2000);
    expect(words(out)).toEqual([0xe1a00000, 0x00030201, 0xdeadbeef, (0x2004 - 0x1000 + 8) >>> 0]);
    expect(measure(block, 0x2000)).toBe(16);
  });
  it('pads odd sizes to a multiple of four', () => {
    const block: CodeBlock = { mode: 'thumb', items: [{ op: 'thumb', halfwords: [0xbf00] }] };
    expect(assemble(block, 0).length).toBe(4);
    expect(measure(block)).toBe(4);
    expect(words(assemble({ mode: 'thumb', items: [{ op: 'wordRel', target: 8, from: 4 }] }, 0))).toEqual([4]);
  });
  it('encodes ARM branches to labels and absolute addresses, conditions and links', () => {
    const block: CodeBlock = {
      mode: 'arm',
      items: [
        { op: 'branch', to: 'end' },
        { op: 'branch', to: 0x100, link: true, cond: 1 },
        { op: 'label', name: 'end' },
        { op: 'branch', to: 0x3000, toMode: 'thumb', link: true },
      ],
    };
    const w = words(assemble(block, 0x1000));
    expect(w[0]).toBe(encodeArmB(0x1000, 0x1008));
    expect(decodeArmBranch(w[1]!, 0x1004)).toEqual({ target: 0x100, mode: 'arm', link: true });
    expect(decodeArmBranch(w[2]!, 0x1008)).toEqual({ target: 0x3000, mode: 'thumb', link: true });
  });
  it('encodes Thumb branches and literal loads', () => {
    const block: CodeBlock = {
      mode: 'thumb',
      items: [
        { op: 'ldr', rt: 1, literal: 'lit' },
        { op: 'ldr', rt: 9, literal: 'lit' },
        { op: 'branch', to: 0x1000 },
        { op: 'branch', to: 0x1000, link: true },
        { op: 'branch', to: 0x2000, toMode: 'arm', link: true },
        { op: 'label', name: 'lit' },
        { op: 'word', value: 7 },
      ],
    };
    const out = assemble(block, 0x4000);
    expect(out.length).toBe(4 * 5 + 4);
    expect(out[2]).toBe(0x00); // T1 ldr is widened with a nop (bf00)
    expect(out[3]).toBe(0xbf);
  });
  it('encodes ARM literal loads', () => {
    const w = words(assemble({ mode: 'arm', items: [{ op: 'ldr', rt: 2, literal: 'x', cond: 0xe }, { op: 'label', name: 'x' }, { op: 'word', value: 5 }] }, 0));
    expect(w[0]).toBe(0xe51f2004);
    expect(words(assemble({ mode: 'arm', items: [{ op: 'ldr', rt: 2, literal: 0 }] }, 8))[0]).toBe(0xe51f2010);
  });
  it('rejects malformed blocks', () => {
    const arm = (items: CodeBlock['items']): CodeBlock => ({ mode: 'arm', items });
    const thumb = (items: CodeBlock['items']): CodeBlock => ({ mode: 'thumb', items });
    expect(() => assemble(arm([{ op: 'label', name: 'a' }, { op: 'label', name: 'a' }]), 0)).toThrow(AsmError);
    expect(() => assemble(arm([{ op: 'branch', to: 'nope' }]), 0)).toThrow('unknown label');
    expect(() => assemble(thumb([{ op: 'arm', words: [0] }]), 0)).toThrow('ARM words in a Thumb block');
    expect(() => assemble(arm([{ op: 'thumb', halfwords: [0] }]), 0)).toThrow('Thumb halfwords in an ARM block');
    expect(() => assemble(arm([{ op: 'branch', to: 0x100, toMode: 'thumb' }]), 0)).toThrow('BLX');
    expect(() => assemble(arm([{ op: 'branch', to: 0x100, toMode: 'thumb', link: true, cond: 1 }]), 0)).toThrow('BLX');
    expect(() => assemble(thumb([{ op: 'branch', to: 0x100, cond: 1 }]), 0)).toThrow('conditional Thumb');
    expect(() => assemble(thumb([{ op: 'branch', to: 0x100, toMode: 'arm' }]), 0)).toThrow('BLX');
  });
});
