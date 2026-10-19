import { DexError, DexSet, decodeAll, type DexClass, type DexFile, type Insn, type MethodInfo } from '../dex';
import { PatchError, type PatchContext } from './types';

/** Opens the APK's dex files; undefined when there are none or one is malformed (the patch is then incompatible). */
export function openDexSet(ctx: PatchContext): DexSet | undefined {
  return ctx.dexCache ? ctx.dexCache.open(ctx.zip) : parseDexSet(ctx);
}

function parseDexSet(ctx: Pick<PatchContext, 'zip'>): DexSet | undefined {
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

/** Pool sizes and edit flag of every parsed dex: equal signatures mean the files still match a fresh parse. */
function signature(set: DexSet | undefined): string {
  return set ? set.names.map((n) => { const d = set.get(n); return [d.dirty, d.strings.length, d.types.length, d.protos.length, d.fields.length, d.methods.length, d.classDefs.length].join(); }).join(';') : '';
}

/**
 * Parsed dex files shared by the `detect` calls of one listPatches run, so the (large) dex files are parsed once instead
 * of once per patch. A detect may assemble code with the dex's own pool, which adds entries: `check()` after each detect
 * drops the parse when that happened, so every detect sees the same state as a fresh parse. Never used for `apply`.
 */
export class DexCache {
  private opened = false;
  private set: DexSet | undefined;
  private sig = '';

  open(zip: PatchContext['zip']): DexSet | undefined {
    if (!this.opened) {
      this.set = parseDexSet({ zip });
      this.sig = signature(this.set);
      this.opened = true;
    }
    return this.set;
  }

  check(): void {
    if (this.opened && signature(this.set) !== this.sig) this.opened = false;
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
