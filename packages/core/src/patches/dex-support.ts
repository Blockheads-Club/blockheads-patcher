import { DexError, DexSet } from '../dex';
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
