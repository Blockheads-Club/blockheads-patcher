import { sha256HexSync } from '../elf/sha256';
import { PatchError, applyVersioning, type Patch, type PatchContext, type PatchCredits, type PatchStatus, type PatchVersioning } from '../patches/types';
import { getEntry, setEntry, type ZipArchive } from '../zip';
import {
  ARM_NOP, COND_AL, THUMB_NOP, decodeArmBranch, decodeThumbBranch, encodeArmB, encodeArmBlxImm, encodeThumbBNarrow, encodeThumbBl,
  encodeThumbBlx, encodeThumbBw, halfwordsToBytes, wordsToBytes, type CodeMode,
} from './arm';
import { assemble, measure, type CodeBlock } from './asm';
import { ElfImage } from './image';

/** Replaces raw bytes. `original` is verified before anything is written. */
export interface BytesEdit {
  kind: 'bytes';
  vaddr: number;
  original: number[];
  replacement: number[];
}
/** Replaces ARM instruction words (32-bit, 4-byte aligned address). */
export interface ArmEdit {
  kind: 'arm';
  vaddr: number;
  original: number[];
  replacement: number[];
}
/** Replaces Thumb halfwords (16-bit units, 2-byte aligned address). */
export interface ThumbEdit {
  kind: 'thumb';
  vaddr: number;
  original: number[];
  replacement: number[];
}
/**
 * Branches from `vaddr` to new code (a "code cave") placed in unused executable padding, or in an appended executable
 * segment when the padding is too small. `original` holds the instructions being replaced (words for ARM, halfwords for
 * Thumb); after the branch the rest of the replaced region is filled with NOPs. The cave must re-create (or deliberately
 * drop) the displaced instructions and branch back by itself, e.g. `{ op: 'branch', to: vaddr + 8 }`; PC-relative displaced
 * instructions have to be rewritten by the spec author. Literal pools are expressed with `word`, `wordRel` and `ldr` items.
 * `link` makes the site branch set lr (BL / BLX). Cross-mode branches (ARM site, Thumb cave or vice versa) are always
 * BLX and therefore clobber lr; the cave decides how to return (`bx` to a saved address, etc.).
 */
export interface CaveEdit {
  kind: 'cave';
  vaddr: number;
  mode: CodeMode;
  original: number[];
  link?: boolean;
  cond?: number;
  code: CodeBlock;
}
/** A pointer to a string, for example the data pointer of a CFString constant. */
export interface StringPointer {
  /** Address of the 32-bit slot that holds the string address (must carry an R_ARM_RELATIVE relocation to be re-pointed). */
  vaddr: number;
  /** Optional address of a 32-bit length field (CFString) that is kept in sync with the string length. */
  lengthVaddr?: number;
}
/**
 * Replaces a NUL-terminated string. A replacement that fits (UTF-8 length <= original) is written in place and padded with
 * NULs; a longer one is stored in newly allocated space and every pointer in `pointers` is re-pointed to it.
 */
export interface StringEdit {
  kind: 'string';
  vaddr: number;
  original: string;
  replacement: string;
  pointers?: StringPointer[];
}
export type NativeEdit = BytesEdit | ArmEdit | ThumbEdit | CaveEdit | StringEdit;

export interface NativePatchVersion {
  versionCode: number;
  versionName: string;
  /** SHA-256 (hex) of the unpatched library entry. */
  libSha256: string;
  edits: NativeEdit[];
}
export interface NativePatchSpec extends PatchVersioning {
  id: string;
  packageName: string;
  libPath: string;
  versions: NativePatchVersion[];
  credits?: PatchCredits;
  optIn?: boolean;
}

type EditState = 'original' | 'applied' | 'invalid';
interface Op {
  state(img: ElfImage): EditState;
  apply(img: ElfImage): void;
}

const same = (a: ArrayLike<number> | undefined, b: ArrayLike<number>): boolean =>
  a !== undefined && a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

function bytesOp(vaddr: number, original: number[], replacement: number[]): Op {
  if (original.length !== replacement.length || original.length === 0) throw new Error('original and replacement must have the same non-zero length');
  return {
    state(img) {
      const cur = img.read(vaddr, original.length);
      return same(cur, original) ? 'original' : same(cur, replacement) ? 'applied' : 'invalid';
    },
    apply: (img) => img.write(vaddr, replacement),
  };
}

function caveOp(e: CaveEdit): Op {
  const unit = e.mode === 'arm' ? 4 : 2;
  const regionLen = e.original.length * unit;
  const originalBytes = e.mode === 'arm' ? wordsToBytes(e.original) : halfwordsToBytes(e.original);
  const link = e.link ?? false;
  const cond = e.cond ?? COND_AL;
  if (e.vaddr % unit !== 0) throw new Error(`cave site 0x${e.vaddr.toString(16)} is not ${unit}-byte aligned`);
  const alignment = Math.max(4, ...e.code.items.map((i) => (i.op === 'align' ? i.to : 0)));
  /** Branch instruction bytes (and size) from the site to `to` (entry address of the cave in e.code.mode). */
  const branchTo = (to: number): number[] => {
    let bytes: number[];
    if (e.mode === 'arm') {
      if (e.code.mode === 'arm') bytes = wordsToBytes([encodeArmB(e.vaddr, to, link, cond)]);
      else if (link && cond === COND_AL) bytes = wordsToBytes([encodeArmBlxImm(e.vaddr, to)]);
      else throw new Error('ARM to Thumb cave branches must be unconditional links (BLX)');
    } else if (cond !== COND_AL) throw new Error('conditional Thumb cave branches are not supported');
    else if (e.code.mode === 'thumb') {
      if (!link && regionLen === 2) bytes = halfwordsToBytes([encodeThumbBNarrow(e.vaddr, to)]);
      else bytes = halfwordsToBytes(link ? encodeThumbBl(e.vaddr, to) : encodeThumbBw(e.vaddr, to));
    } else if (link) bytes = halfwordsToBytes(encodeThumbBlx(e.vaddr, to));
    else throw new Error('Thumb to ARM cave branches must be links (BLX)');
    if (bytes.length > regionLen) throw new Error(`replaced region (${regionLen} bytes) is smaller than the branch (${bytes.length} bytes)`);
    const nop = e.mode === 'arm' ? wordsToBytes([ARM_NOP]) : halfwordsToBytes([THUMB_NOP]);
    while (bytes.length < regionLen) bytes.push(...nop);
    return bytes;
  };
  return {
    state(img) {
      const cur = img.read(e.vaddr, regionLen);
      if (same(cur, originalBytes)) return 'original';
      if (!cur) return 'invalid';
      const dv = new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
      const d = e.mode === 'arm' ? decodeArmBranch(dv.getUint32(0, true), e.vaddr)
        : decodeThumbBranch(dv.getUint16(0, true), regionLen >= 4 ? dv.getUint16(2, true) : 0, e.vaddr);
      if (!d || d.mode !== e.code.mode) return 'invalid';
      let expected: number[];
      try { expected = branchTo(d.target); } catch { return 'invalid'; }
      if (!same(cur, expected)) return 'invalid';
      const code = assemble(e.code, d.target);
      return same(img.read(d.target, code.length), code) ? 'applied' : 'invalid';
    },
    apply(img) {
      const addr = img.allocate(measure(e.code), alignment);
      img.write(addr, assemble(e.code, addr));
      img.write(e.vaddr, branchTo(addr));
    },
  };
}

function stringOp(e: StringEdit): Op {
  const enc = new TextEncoder();
  const orig = enc.encode(e.original);
  const repl = enc.encode(e.replacement);
  if (orig.includes(0) || repl.includes(0)) throw new Error('strings must not contain NUL');
  const pointers = e.pointers ?? [];
  const inPlace = repl.length <= orig.length;
  if (!inPlace && pointers.length === 0) throw new Error('a longer replacement needs at least one pointer to re-point');
  const pad = (b: Uint8Array): number[] => [...b, ...new Array<number>(orig.length + 1 - b.length).fill(0)];
  const lengthsAre = (img: ElfImage, n: number): boolean => pointers.every((p) => p.lengthVaddr === undefined || img.readU32(p.lengthVaddr) === n);
  const pointsTo = (img: ElfImage, v: (p: number) => boolean): boolean => pointers.every((p) => {
    const cur = img.readU32(p.vaddr);
    return cur !== undefined && v(cur);
  });
  return {
    state(img) {
      const cur = img.read(e.vaddr, orig.length + 1);
      if (inPlace) {
        if (same(cur, [...orig, 0]) && lengthsAre(img, e.original.length)) return 'original';
        return same(cur, pad(repl)) && lengthsAre(img, e.replacement.length) ? 'applied' : 'invalid';
      }
      if (same(cur, [...orig, 0]) && pointsTo(img, (p) => p === e.vaddr) && lengthsAre(img, e.original.length))
        return pointers.every((p) => img.hasRelativeReloc(p.vaddr)) ? 'original' : 'invalid';
      return pointsTo(img, (p) => p !== e.vaddr && img.readCString(p) === e.replacement) && lengthsAre(img, e.replacement.length) ? 'applied' : 'invalid';
    },
    apply(img) {
      if (inPlace) {
        img.write(e.vaddr, pad(repl));
        for (const p of pointers) if (p.lengthVaddr !== undefined) img.writeU32(p.lengthVaddr, e.replacement.length);
        return;
      }
      const addr = img.allocate(repl.length + 1, 1);
      img.write(addr, [...repl, 0]);
      for (const p of pointers) {
        img.writeU32(p.vaddr, addr);
        if (p.lengthVaddr !== undefined) img.writeU32(p.lengthVaddr, e.replacement.length);
      }
    },
  };
}

/** Turns a declarative edit into an operation; throws a plain Error for malformed specs (programming errors). */
export function toOp(e: NativeEdit): Op {
  switch (e.kind) {
    case 'bytes': return bytesOp(e.vaddr, e.original, e.replacement);
    case 'arm':
      if (e.vaddr % 4 !== 0) throw new Error(`ARM edit at 0x${e.vaddr.toString(16)} is not 4-byte aligned`);
      return bytesOp(e.vaddr, wordsToBytes(e.original), wordsToBytes(e.replacement));
    case 'thumb':
      if (e.vaddr % 2 !== 0) throw new Error(`Thumb edit at 0x${e.vaddr.toString(16)} is not 2-byte aligned`);
      return bytesOp(e.vaddr, halfwordsToBytes(e.original), halfwordsToBytes(e.replacement));
    case 'cave': return caveOp(e);
    case 'string': return stringOp(e);
  }
}

/**
 * First-seen SHA-256 of each library (or other entry) per archive. The pipeline applies patches one after another to the same archive, and
 * every applied native patch changes the library hash; the hash pin therefore refers to the library as first seen.
 */
const baseline = new WeakMap<ZipArchive, Map<string, string>>();
export function baselineSha(zip: ZipArchive, path: string, data: Uint8Array): string {
  let m = baseline.get(zip);
  if (!m) baseline.set(zip, (m = new Map()));
  let sha = m.get(path);
  if (sha === undefined) m.set(path, (sha = sha256HexSync(data)));
  return sha;
}

/**
 * Builds a patch that edits a native library per app version. Each version pins the unpatched library by SHA-256 and every
 * edit verifies the bytes it replaces; anything else makes the patch `incompatible`.
 */
export function makeNativePatch(spec: NativePatchSpec): Patch {
  const codes = spec.versions.map((v) => v.versionCode);
  const ops = new Map(spec.versions.map((v) => [v.versionCode, v.edits.map(toOp)]));
  const detect = (ctx: PatchContext): PatchStatus => {
    const ver = spec.versions.find((v) => v.versionCode === ctx.info.versionCode);
    const entry = getEntry(ctx.zip, spec.libPath);
    if (!ver || !entry) return 'incompatible';
    let img: ElfImage;
    try { img = new ElfImage(entry.data, false); } catch { return 'incompatible'; }
    const states = ops.get(ver.versionCode)!.map((o) => o.state(img));
    if (states.every((s) => s === 'applied')) return 'applied';
    if (states.every((s) => s === 'original') && baselineSha(ctx.zip, spec.libPath, entry.data) === ver.libSha256) return 'notApplied';
    return 'incompatible';
  };
  const patch: Patch = applyVersioning({
    id: spec.id,
    version: 1,
    nameKey: `patch.${spec.id}.name`,
    descriptionKey: `patch.${spec.id}.description`,
    appliesTo: {
      packageName: spec.packageName,
      versionCode: { min: Math.min(...codes), max: Math.max(...codes) },
      versionNames: spec.versions.map((v) => v.versionName),
    },
    detect,
    apply(ctx) {
      const status = detect(ctx);
      if (status !== 'notApplied') throw new PatchError(`${spec.id} cannot be applied (status: ${status})`, 'cannotApply', { status });
      const entry = getEntry(ctx.zip, spec.libPath)!;
      const img = new ElfImage(entry.data);
      for (const op of ops.get(ctx.info.versionCode!)!) op.apply(img);
      setEntry(ctx.zip, { name: spec.libPath, data: img.data });
      ctx.log(`${spec.id}: patched ${spec.libPath}`);
    },
  }, spec);
  if (spec.credits) patch.credits = spec.credits;
  if (spec.optIn) patch.optIn = true;
  return patch;
}
