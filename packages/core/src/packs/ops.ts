import { ANDROID_NS, ValueType, addAttr, getAttr, removeAttr, setAttrString, setAttrValue, type AxmlAttribute, type AxmlElement } from '../axml';
import { CodeBuilder, DexFile, validateDex } from '../dex';
import { findElfSymbol, parseElfSections } from '../elf/symbols';
import { ElfImage } from '../native/image';
import { findObjcMethod } from '../native/objc';
import { baselineSha } from '../native/spec';
import { calleeOf, editDex, insnsOf, openDexSet } from '../patches/dex-support';
import { findActivityByName, findApplication } from '../patches/manifest-flags';
import type { PatchContext } from '../patches/types';
import { getEntry, peekData, setEntry } from '../zip';
import { arrayAppend, arrayHasString, countOf, parsePlist, plistHas, plistSet, type PlistScalar } from './plist';
import { PACK_LIMITS, PACK_MANIFEST_ATTRS } from './schema';

export type Target = 'application' | { activity: string };
export type Locate = { symbol: string; add?: number } | { objcMethod: string; add?: number } | { vaddr: number } | { fileOffset: number };
export type PackOp =
  | { op: 'manifest.set'; target: Target; attr: string; value: PlistScalar }
  | { op: 'manifest.remove'; target: Target; attr: string }
  | { op: 'file.add'; path: string; from: string }
  | { op: 'file.replace'; path: string; from: string; expectSha256?: string }
  | { op: 'plist.set'; path: string; key: string; value: PlistScalar }
  | { op: 'plist.arrayInsert'; path: string; key: string; value: string }
  | { op: 'text.replace'; path: string; find: string; replace: string }
  | { op: 'native.patch'; lib: string; locate: Locate; expect: string; replace: string; libSha256?: string }
  | { op: 'dex.add'; from: string }
  | { op: 'dex.hook'; class: string; method: string; params?: string[]; returns?: string; at?: 'start'; call: string };

/** `pending` = can be applied, `done` = already in effect, `blocked` = this APK does not fit (the reason says why). */
export type OpState = { s: 'pending' } | { s: 'done' } | { s: 'blocked'; why: string };
export interface CompiledOp {
  /** Things this operation writes, for conflict reports (`file:`, `manifest:`, `native:`, `dex-class:`). */
  writes: string[];
  /** Pack-relative paths of the payload files this operation reads. */
  reads: string[];
  state(ctx: PatchContext): OpState;
  apply(ctx: PatchContext): void;
}
/** Thrown while compiling a pack: a semantic error in one operation. */
export class PackOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackOpError';
  }
}

const PENDING: OpState = { s: 'pending' };
const DONE: OpState = { s: 'done' };
const blocked = (why: string): OpState => ({ s: 'blocked', why });
const enc = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.replace(/ /g, '').match(/../g)!, (x) => parseInt(x, 16));

/** Class namespaces a pack's dex may not define (platform, runtime and the patcher's own helpers). */
export const RESERVED_CLASS_PREFIXES = ['Ljava/', 'Ljavax/', 'Landroid/', 'Landroidx/', 'Ldalvik/', 'Lkotlin/', 'Lsun/', 'Llibcore/', 'Lorg/apache/harmony/', 'Lcom/android/', 'Lcom/google/android/', 'Lcom/blockheadsclub/patch/', 'Lcom/blockheadsclub/modloader/'];

export interface CompileEnv {
  /** Payload files of the pack by path. */
  file(path: string): Uint8Array;
  /** Dex files added by earlier `dex.add` operations of the same patch. */
  dexes: DexFile[];
}

/** Turns one validated operation into an executable one; throws PackOpError for semantic errors. */
export function compileOp(op: PackOp, env: CompileEnv): CompiledOp {
  switch (op.op) {
    case 'manifest.set':
    case 'manifest.remove': return manifestOp(op);
    case 'file.add':
    case 'file.replace': return fileOp(op, env.file(op.from));
    case 'plist.set':
    case 'plist.arrayInsert':
    case 'text.replace': return textOp(op);
    case 'native.patch': return nativeOp(op);
    case 'dex.add': return dexAddOp(op, env.file(op.from), env);
    case 'dex.hook': return dexHookOp(op, env);
  }
}

// ---- manifest ---------------------------------------------------------------------------------------------------

function manifestOp(op: Extract<PackOp, { op: 'manifest.set' | 'manifest.remove' }>): CompiledOp {
  const spec = PACK_MANIFEST_ATTRS[op.attr]!;
  const where = op.target === 'application' ? 'application' : 'activity';
  if (!spec.on.includes(where)) throw new PackOpError(`android:${op.attr} cannot be set on <${where}>`);
  const label = op.target === 'application' ? 'application' : `activity ${op.target.activity}`;
  const locate = (ctx: PatchContext): AxmlElement | undefined =>
    op.target === 'application' ? findApplication(ctx) : findActivityByName(ctx, op.target.activity);
  const attrOf = (el: AxmlElement): AxmlAttribute | undefined => getAttr(el, op.attr, ANDROID_NS, spec.id);
  const writes = [`manifest:${label}@${op.attr}`];
  if (op.op === 'manifest.remove') {
    return {
      writes, reads: [],
      state(ctx) {
        const el = locate(ctx);
        if (!el) return blocked(`no ${label} in the manifest`);
        return attrOf(el) ? PENDING : DONE;
      },
      apply(ctx) {
        const el = locate(ctx)!;
        removeAttr(ctx.manifest, el, attrOf(el)!);
        ctx.markManifestDirty();
      },
    };
  }
  const v = op.value;
  let type: ValueType, data = 0;
  switch (spec.kind) {
    case 'string':
      if (typeof v !== 'string') throw new PackOpError(`android:${op.attr} needs a string value`);
      type = ValueType.String;
      break;
    case 'boolean':
      if (typeof v !== 'boolean') throw new PackOpError(`android:${op.attr} needs a boolean value`);
      type = ValueType.IntBoolean; data = v ? 0xffffffff : 0;
      break;
    case 'platformRef':
      if (typeof v !== 'number' || v >>> 24 !== 0x01) throw new PackOpError(`android:${op.attr} needs an android platform resource id (0x01xxxxxx)`);
      type = ValueType.Reference; data = v;
      break;
    default:
      if (typeof v !== 'number' || v < 0) throw new PackOpError(`android:${op.attr} needs a non-negative integer value`);
      type = spec.kind === 'flags' ? ValueType.IntHex : ValueType.IntDec; data = v;
  }
  const has = (a: AxmlAttribute | undefined): boolean =>
    !!a && a.valueType === type && (type === ValueType.String ? a.stringValue === v : a.data >>> 0 === data >>> 0);
  return {
    writes, reads: [],
    state(ctx) {
      const el = locate(ctx);
      if (!el) return blocked(`no ${label} in the manifest`);
      return has(attrOf(el)) ? DONE : PENDING;
    },
    apply(ctx) {
      const el = locate(ctx)!;
      const a = attrOf(el);
      if (a && type === ValueType.String) setAttrString(ctx.manifest, a, v as string);
      else if (a) setAttrValue(ctx.manifest, a, type, data);
      else addAttr(ctx.manifest, el, { nsUri: ANDROID_NS, name: op.attr, resourceId: spec.id, rawValue: type === ValueType.String ? (v as string) : null, valueType: type, data });
      ctx.markManifestDirty();
    },
  };
}

// ---- files ------------------------------------------------------------------------------------------------------

function fileOp(op: Extract<PackOp, { op: 'file.add' | 'file.replace' }>, payload: Uint8Array): CompiledOp {
  return {
    writes: [`file:${op.path}`], reads: [op.from],
    state(ctx) {
      const e = getEntry(ctx.zip, op.path);
      if (e && sameBytes(peekData(e), payload)) return DONE;
      if (op.op === 'file.add') return e ? blocked(`${op.path} already exists`) : PENDING;
      if (!e) return blocked(`${op.path} does not exist`);
      if (op.expectSha256 && baselineSha(ctx.zip, op.path, peekData(e)) !== op.expectSha256) return blocked(`${op.path} is not the expected version`);
      return PENDING;
    },
    apply(ctx) {
      setEntry(ctx.zip, { name: op.path, data: payload.slice() });
    },
  };
}

// ---- text and property lists ------------------------------------------------------------------------------------

function textOp(op: Extract<PackOp, { op: 'plist.set' | 'plist.arrayInsert' | 'text.replace' }>): CompiledOp {
  if (op.op === 'text.replace' && op.replace.includes(op.find)) throw new PackOpError('text.replace: `replace` must not contain `find`');
  const read = (ctx: PatchContext): string | undefined => {
    const e = getEntry(ctx.zip, op.path);
    if (!e) return undefined;
    try { return utf8.decode(peekData(e)); } catch { return undefined; }
  };
  /** The new text, or a state when nothing is to be written. */
  const edit = (text: string): string | OpState => {
    if (op.op === 'text.replace') {
      const n = countOf(text, op.find);
      if (n === 1) return text.replace(op.find, () => op.replace);
      return n === 0 && text.includes(op.replace) ? DONE : blocked(`${op.path}: expected exactly one occurrence of the text to replace, found ${n}`);
    }
    const doc = parsePlist(text);
    if (!doc) return blocked(`${op.path} is not an XML property list`);
    const e = doc.entries.get(op.key);
    if (op.op === 'plist.set') return e && plistHas(text, e, op.value) ? DONE : plistSet(text, doc, op.key, op.value);
    if (!e || e.tag !== 'array') return blocked(`${op.path}: ${op.key} is not an array`);
    return arrayHasString(text, e, op.value) ? DONE : arrayAppend(text, e, op.value);
  };
  const run = (ctx: PatchContext): string | OpState => {
    const text = read(ctx);
    return text === undefined ? blocked(`${op.path} is missing or not UTF-8 text`) : edit(text);
  };
  return {
    writes: [op.op === 'text.replace' ? `file:${op.path}` : `plist:${op.path}#${op.key}`], reads: [],
    state(ctx) {
      const r = run(ctx);
      return typeof r === 'string' ? PENDING : r;
    },
    apply(ctx) {
      setEntry(ctx.zip, { name: op.path, data: enc.encode(run(ctx) as string) });
    },
  };
}

// ---- native -----------------------------------------------------------------------------------------------------

function nativeOp(op: Extract<PackOp, { op: 'native.patch' }>): CompiledOp {
  const expect = fromHex(op.expect), replace = fromHex(op.replace);
  if (expect.length !== replace.length) throw new PackOpError('native.patch: `expect` and `replace` must have the same length');
  if (expect.length > PACK_LIMITS.hexBytes) throw new PackOpError(`native.patch: at most ${PACK_LIMITS.hexBytes} bytes per operation`);
  if (sameBytes(expect, replace)) throw new PackOpError('native.patch: `replace` equals `expect`');
  const loc = op.locate;
  const where = 'symbol' in loc ? `symbol ${loc.symbol}` : 'objcMethod' in loc ? loc.objcMethod : 'vaddr' in loc ? `0x${loc.vaddr.toString(16)}` : `file offset 0x${loc.fileOffset.toString(16)}`;
  /** File offset of the patched bytes, or a reason why it cannot be found. */
  const offsetOf = (data: Uint8Array): number | string => {
    if ('fileOffset' in loc) return loc.fileOffset + expect.length <= data.length ? loc.fileOffset : `${where} is beyond the end of ${op.lib}`;
    let img: ElfImage;
    try { img = new ElfImage(data, false); } catch { return `${op.lib} is not an ELF library`; }
    let vaddr: number | undefined;
    if ('vaddr' in loc) vaddr = loc.vaddr;
    else {
      let sections;
      try { sections = parseElfSections(data); } catch { return `${op.lib} has no readable section headers`; }
      const base = 'symbol' in loc ? findElfSymbol(data, sections, loc.symbol) : findObjcMethod(img, sections, loc.objcMethod);
      if (base === undefined) return `${where} not found in ${op.lib}`;
      vaddr = base + (loc.add ?? 0);
    }
    return img.offsetOf(vaddr, expect.length) ?? `${where} is not backed by ${op.lib}`;
  };
  const probe = (ctx: PatchContext): { state: OpState; data?: Uint8Array; off?: number } => {
    const e = getEntry(ctx.zip, op.lib);
    if (!e) return { state: blocked(`${op.lib} is missing`) };
    const data = e.data;
    const off = offsetOf(data);
    if (typeof off === 'string') return { state: blocked(off) };
    const cur = data.subarray(off, off + expect.length);
    if (sameBytes(cur, replace)) return { state: DONE };
    if (!sameBytes(cur, expect)) return { state: blocked(`${where}: the bytes in ${op.lib} are not the expected ones`) };
    if (op.libSha256 && baselineSha(ctx.zip, op.lib, data) !== op.libSha256) return { state: blocked(`${op.lib} is not the expected build`) };
    return { state: PENDING, data, off };
  };
  return {
    writes: [`native:${op.lib}@${where}`], reads: [],
    state: (ctx) => probe(ctx).state,
    apply(ctx) {
      const { data, off } = probe(ctx);
      const out = data!.slice();
      out.set(replace, off!);
      setEntry(ctx.zip, { name: op.lib, data: out });
    },
  };
}

// ---- dex --------------------------------------------------------------------------------------------------------

const DEX_NAME = (i: number): string => (i === 0 ? 'classes.dex' : `classes${i + 1}.dex`);

function dexAddOp(op: Extract<PackOp, { op: 'dex.add' }>, bytes: Uint8Array, env: CompileEnv): CompiledOp {
  const problems = validateDex(bytes);
  if (problems.length) throw new PackOpError(`dex.add ${op.from}: not a valid dex (${problems[0]})`);
  const dex = DexFile.parse(bytes);
  const classes = dex.classNames();
  if (!classes.length) throw new PackOpError(`dex.add ${op.from}: defines no classes`);
  const reserved = classes.find((c) => RESERVED_CLASS_PREFIXES.some((p) => c.startsWith(p)));
  if (reserved) throw new PackOpError(`dex.add ${op.from}: ${reserved} is in a reserved namespace`);
  env.dexes.push(dex);
  return {
    writes: classes.map((c) => `dex-class:${c}`), reads: [op.from],
    state(ctx) {
      const set = openDexSet(ctx);
      if (!set) return blocked('the APK has no readable dex files');
      const present = classes.filter((c) => set.findClass(c)).length;
      if (present === classes.length) return DONE;
      if (present) return blocked(`${op.from}: some of its classes already exist in the APK`);
      if (set.names.some((n, i) => n !== DEX_NAME(i))) return blocked('the APK dex files are not numbered consecutively');
      return PENDING;
    },
    apply(ctx) {
      const n = openDexSet(ctx)!.names.length;
      setEntry(ctx.zip, { name: DEX_NAME(n), data: bytes.slice() });
    },
  };
}

const CALL_RE = /^(L[^;]+;)->([^(]+)\(((?:L[^;]+;)?)\)V$/;
const OBJECT = 'Ljava/lang/Object;';
const ACC_STATIC = 0x8;

function dexHookOp(op: Extract<PackOp, { op: 'dex.hook' }>, env: CompileEnv): CompiledOp {
  const [, callCls, callName, callParam] = CALL_RE.exec(op.call)! as unknown as [string, string, string, string];
  const params = op.params ?? [], returns = op.returns ?? 'V';
  const passThis = callParam !== '';
  if (passThis && callParam !== op.class && callParam !== OBJECT) throw new PackOpError(`dex.hook: the called method may only take the instance (${op.class} or ${OBJECT})`);
  if (op.method === '<init>') throw new PackOpError('dex.hook: constructors cannot be hooked');
  const owner = env.dexes.find((d) => d.findClass(callCls));
  const target = owner?.findClass(callCls)?.findMethod(callName, passThis ? [callParam] : [], 'V');
  if (!target || !(target.access & ACC_STATIC)) throw new PackOpError(`dex.hook: ${op.call} must be a static method of a class added by an earlier dex.add of this patch`);
  const sig = `${op.class}->${op.method}(${params.join('')})${returns}`;
  const locate = (ctx: PatchContext) => {
    const set = openDexSet(ctx);
    const hit = set?.findClass(op.class);
    const m = hit?.cls.findMethod(op.method, params, returns);
    return { set, hit, m };
  };
  return {
    writes: [], reads: [],
    state(ctx) {
      const { hit, m } = locate(ctx);
      if (!hit || !m?.hasCode) return blocked(`${sig} not found`);
      if (passThis && m.access & ACC_STATIC) return blocked(`${sig} is static, so there is no instance to pass`);
      const called = insnsOf(hit.cls, m).some((i) => {
        const c = calleeOf(hit.dex, i);
        return c?.cls === callCls && c.name === callName && c.ret === 'V' && c.params.join('') === callParam;
      });
      return called ? DONE : PENDING;
    },
    apply(ctx) {
      const { set, hit, m } = locate(ctx);
      editDex(sig, () => {
        const idx = hit!.dex.method(callCls, callName, 'V', passThis ? [callParam] : []);
        hit!.cls.prependCode(m!, (registers, ins) => {
          const b = new CodeBuilder({ registers, outs: passThis ? 1 : 0 });
          return passThis ? b.op('invoke-static/range', idx, registers - ins, 1) : b.op('invoke-static', idx);
        });
        set!.commit();
      });
    },
  };
}
