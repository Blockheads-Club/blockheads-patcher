import { DexError, DexSet, decodeAll, type DexClass, type DexFile, type Insn, type MethodInfo } from '../dex';
import { PatchError, type PatchContext } from './types';

/** Opens the APK's dex files; undefined when there are none or one is malformed (the patch is then incompatible). */
export function openDexSet(ctx: PatchContext): DexSet | undefined {
  try {
    const set = new DexSet(ctx.zip);
    if (!set.names.length) return undefined;
    set.names.forEach((n) => set.get(n));
    return set;
  } catch (e) {
    if (e instanceof DexError) return undefined;
    throw e;
  }
}

/** Runs a dex edit, turning editing errors into PatchError so UIs can report them. */
export function editDex<T>(id: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DexError) throw new PatchError(`${id}: ${e.message}`, 'cannotApply', { status: 'dexError', detail: e.message });
    throw e;
  }
}

export interface MethodDesc { cls: string; name: string; params: string[]; ret: string }

/** Class, name and signature of a method_ids entry. */
export function describeMethod(dex: DexFile, idx: number): MethodDesc {
  const m = dex.methods[idx]!, p = dex.protos[m.proto]!;
  return { cls: dex.typeName(m.cls), name: dex.text(m.name), params: p.params.map((t) => dex.typeName(t)), ret: dex.typeName(p.ret) };
}

/** Decoded instructions of a method's code (empty when the method has none). */
export function insnsOf(cls: DexClass, m: MethodInfo): Insn[] {
  const code = cls.codeOf(m);
  return code ? decodeAll(code.insns) : [];
}

/** The called method of an invoke instruction (undefined for any other instruction). */
export function calleeOf(dex: DexFile, i: Insn): MethodDesc | undefined {
  return i.ref?.kind === 'method' ? describeMethod(dex, i.ref.index) : undefined;
}

/** True when any invoke in the method calls a method declared in class `target`. */
export function callsClass(dex: DexFile, cls: DexClass, m: MethodInfo, target: string): boolean {
  return insnsOf(cls, m).some((i) => calleeOf(dex, i)?.cls === target);
}
