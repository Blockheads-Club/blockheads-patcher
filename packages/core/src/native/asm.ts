import {
  COND_AL, THUMB_NOP, encodeArmB, encodeArmBlxImm, encodeArmLdrLiteral, encodeThumbBl,
  encodeThumbBlx, encodeThumbBw, encodeThumbLdrLiteral, halfwordsToBytes, wordsToBytes, type CodeMode,
} from './arm';

/** A branch/literal operand: an absolute virtual address or the name of a label inside the same code block. */
export type Target = number | string;

export type CodeItem =
  /** Raw ARM instruction words (arm blocks only). */
  | { op: 'arm'; words: number[] }
  /** Raw Thumb halfwords (thumb blocks only). */
  | { op: 'thumb'; halfwords: number[] }
  | { op: 'bytes'; bytes: number[] }
  | { op: 'label'; name: string }
  /** Pads with zero bytes up to the alignment (2, 4 or 8). */
  | { op: 'align'; to: number }
  /**
   * Branch to `to`. `toMode` is the mode of the target (default: the block's own mode). Interworking branches use BLX
   * and therefore always set lr (and must be unconditional in ARM).
   */
  | { op: 'branch'; to: Target; link?: boolean; cond?: number; toMode?: CodeMode }
  /** PC-relative literal load `ldr rt, [pc, #off]` of the word at `literal`. */
  | { op: 'ldr'; rt: number; literal: Target; cond?: number }
  /** A 32-bit data word: a constant, or `target - from + add` (position independent offsets). */
  | { op: 'word'; value: number }
  | { op: 'wordRel'; target: Target; from: Target; add?: number };

export interface CodeBlock {
  mode: CodeMode;
  items: CodeItem[];
}

export class AsmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsmError';
  }
}

function sizeOf(item: CodeItem, at: number): number {
  switch (item.op) {
    case 'arm': return item.words.length * 4;
    case 'thumb': return item.halfwords.length * 2;
    case 'bytes': return item.bytes.length;
    case 'label': return 0;
    case 'align': return (item.to - (at % item.to)) % item.to;
    default: return 4; // word, wordRel, branch and ldr are always 4 bytes
  }
}

/**
 * Assembles a block located at `base`. Every item has a size that does not depend on operand values (Thumb `ldr` is
 * always 4 bytes), so labels are resolved in one pass. The result is padded to a multiple of 4 bytes.
 */
export function assemble(block: CodeBlock, base: number): Uint8Array {
  const { mode } = block;
  const check = (item: CodeItem): void => {
    if (item.op === 'arm' && mode !== 'arm') throw new AsmError('ARM words in a Thumb block');
    if (item.op === 'thumb' && mode !== 'thumb') throw new AsmError('Thumb halfwords in an ARM block');
  };
  const labels = new Map<string, number>();
  let at = base;
  const sizes: number[] = [];
  for (const item of block.items) {
    check(item);
    if (item.op === 'label') {
      if (labels.has(item.name)) throw new AsmError(`duplicate label ${item.name}`);
      labels.set(item.name, at);
    }
    const sz = sizeOf(item, at);
    sizes.push(sz);
    at += sz;
  }
  const resolve = (t: Target): number => {
    if (typeof t === 'number') return t;
    const v = labels.get(t);
    if (v === undefined) throw new AsmError(`unknown label ${t}`);
    return v;
  };
  const out: number[] = [];
  at = base;
  block.items.forEach((item, i) => {
    switch (item.op) {
      case 'arm': out.push(...wordsToBytes(item.words)); break;
      case 'thumb': out.push(...halfwordsToBytes(item.halfwords)); break;
      case 'bytes': out.push(...item.bytes); break;
      case 'label': break;
      case 'align': for (let k = 0; k < sizes[i]!; k++) out.push(0); break;
      case 'word': out.push(...wordsToBytes([item.value >>> 0])); break;
      case 'wordRel': out.push(...wordsToBytes([(resolve(item.target) - resolve(item.from) + (item.add ?? 0)) >>> 0])); break;
      case 'ldr':
        if (mode === 'arm') out.push(...wordsToBytes([encodeArmLdrLiteral(item.rt, at, resolve(item.literal), item.cond ?? COND_AL)]));
        else {
          const hw = encodeThumbLdrLiteral(item.rt, at, resolve(item.literal));
          // always 4 bytes: widen the 16-bit form with a nop so sizes stay operand independent
          out.push(...halfwordsToBytes(hw.length === 1 ? [...hw, THUMB_NOP] : hw));
        }
        break;
      case 'branch': {
        const to = resolve(item.to);
        const toMode = item.toMode ?? mode;
        const link = item.link ?? false;
        const cond = item.cond ?? COND_AL;
        if (mode === 'arm') {
          if (toMode === 'arm') out.push(...wordsToBytes([encodeArmB(at, to, link, cond)]));
          else {
            if (cond !== COND_AL || !link) throw new AsmError('ARM to Thumb branches must be unconditional links (BLX)');
            out.push(...wordsToBytes([encodeArmBlxImm(at, to)]));
          }
        } else {
          if (cond !== COND_AL) throw new AsmError('conditional Thumb branches are not supported');
          if (toMode === 'thumb') out.push(...halfwordsToBytes(link ? encodeThumbBl(at, to) : encodeThumbBw(at, to)));
          else {
            if (!link) throw new AsmError('Thumb to ARM branches must be links (BLX)');
            out.push(...halfwordsToBytes(encodeThumbBlx(at, to)));
          }
        }
        break;
      }
    }
    at += sizes[i]!;
  });
  while (out.length % 4 !== 0) out.push(0);
  return Uint8Array.from(out);
}

/** Size in bytes of the assembled block (a multiple of 4); independent of the load address except for `align` items. */
export function measure(block: CodeBlock, base = 0): number {
  let at = base;
  for (const item of block.items) at += sizeOf(item, at);
  return Math.ceil((at - base) / 4) * 4;
}
