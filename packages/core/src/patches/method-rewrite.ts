import type { CodeBuilder, DexClass, DexFile } from '../dex';
import { editDex, openDexSet } from './dex-support';
import { PatchError, applyVersioning, type Patch, type PatchContext, type PatchCredits, type PatchStatus, type PatchVersioning } from './types';

export interface MethodRewriteSpec extends PatchVersioning {
  id: string;
  credits?: PatchCredits;
  optIn?: boolean;
  /** Descriptor of the class that owns the method, e.g. `Lcom/x/Y;`. */
  cls: string;
  method: { name: string; params: string[]; returnType: string };
  /** Assembles the method body exactly as the game ships it; the patch only touches a method whose code equals this. */
  original(dex: DexFile): CodeBuilder;
  /** Assembles the replacement body. */
  patched(dex: DexFile): CodeBuilder;
  /** Optional hook run before the body is replaced (for example to add a helper method to the class). */
  prepare?(dex: DexFile, cls: DexClass): void;
  /** Log line written after applying. */
  logMessage: string;
}

const same = (a: Uint16Array, b: Uint16Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Builds a patch that replaces the body of one method. Both the shipped body and the replacement are assembled
 * with the dex's own constant pool, so detection is an exact comparison: unknown code is reported as incompatible
 * instead of being overwritten.
 */
export function makeMethodRewritePatch(spec: MethodRewriteSpec): Patch {
  const { name, params, returnType } = spec.method;
  const inspect = (ctx: PatchContext) => {
    const set = openDexSet(ctx);
    const found = set?.findClass(spec.cls);
    const info = found?.cls.findMethod(name, params, returnType);
    if (!set || !found || !info?.hasCode) return undefined;
    const data = found.dex.classData(found.cls.def);
    const code = (info.direct ? data.directMethods : data.virtualMethods).find((m) => m.idx === info.idx)!.code!;
    const ins = (info.access & 8 ? 0 : 1) + params.reduce((n, p) => n + (p === 'J' || p === 'D' ? 2 : 1), 0);
    return { set, dex: found.dex, cls: found.cls, info, code, ins };
  };
  const detect = (ctx: PatchContext): PatchStatus => {
    const t = inspect(ctx);
    if (!t) return 'incompatible';
    // the replacement is assembled first: it may add pool entries (e.g. a helper method) that the original never needs
    if (same(t.code.insns, spec.patched(t.dex).build(t.ins).insns)) return 'applied';
    return same(t.code.insns, spec.original(t.dex).build(t.ins).insns) ? 'notApplied' : 'incompatible';
  };
  return applyVersioning({
    id: spec.id,
    version: 1,
    nameKey: `patch.${spec.id}.name`,
    descriptionKey: `patch.${spec.id}.description`,
    appliesTo: { packageName: 'com.noodlecake.blockheads' },
    ...(spec.credits ? { credits: spec.credits } : {}),
    ...(spec.optIn ? { optIn: true } : {}),
    detect,
    apply(ctx) {
      const status = detect(ctx);
      if (status !== 'notApplied') throw new PatchError(`${spec.id} cannot be applied (status: ${status})`, 'cannotApply', { status });
      const t = inspect(ctx)!;
      editDex(spec.id, () => {
        spec.prepare?.(t.dex, t.cls);
        t.cls.replaceBody(t.info, spec.patched(t.dex));
        t.set.commit();
      });
      ctx.log(spec.logMessage);
    },
  }, spec);
}
