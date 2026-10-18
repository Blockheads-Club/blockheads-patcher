import { JARLPENGUIN_CREDITS } from './credits';
import { calleeOf, editDex, insnsOf, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';
import type { DexClass, DexFile, DexSet, MethodInfo } from '../dex';

const TEXT_VIEW = 'Lcom/apportable/ui/TextView;';
/** Gravity.TOP | Gravity.LEFT, hard-coded by the game; and Gravity.TOP | Gravity.CENTER_HORIZONTAL. */
export const GRAVITY_ORIGINAL = 0x33;
export const GRAVITY_CENTRED = 0x31;

interface Site { set: DexSet; dex: DexFile; cls: DexClass; method: MethodInfo; at: number; value: number }

/** Finds `const/16 vX, #gravity` directly followed by `EditText.setGravity(int)` inside `TextView.init()`. */
function locate(ctx: PatchContext): Site | undefined {
  const set = openDexSet(ctx);
  const hit = set?.findClass(TEXT_VIEW);
  const method = hit?.cls.findMethod('init', [], 'V');
  if (!hit || !method?.hasCode) return undefined;
  const list = insnsOf(hit.cls, method);
  for (let k = 0; k + 1 < list.length; k++) {
    const lit = list[k]!, call = list[k + 1]!;
    if (lit.name !== 'const/16' || call.name !== 'invoke-virtual') continue;
    const callee = calleeOf(hit.dex, call);
    if (callee?.name !== 'setGravity' || callee.params.join() !== 'I' || call.operands[2] !== lit.operands[0]) continue;
    return { set: set!, dex: hit.dex, cls: hit.cls, method, at: lit.at, value: lit.operands[1]! };
  }
  return undefined;
}

function detect(ctx: PatchContext): PatchStatus {
  const site = locate(ctx);
  if (!site) return 'incompatible';
  if (site.value === GRAVITY_CENTRED) return 'applied';
  return site.value === GRAVITY_ORIGINAL ? 'notApplied' : 'incompatible';
}

/**
 * The sign editor is an Android `EditText` created by Apportable's `UITextView` glue, which hard-codes
 * `setGravity(TOP | LEFT)` and never forwards the game's `setTextAlignment:`. The literal is changed to
 * `TOP | CENTER_HORIZONTAL`. The Java class is shared by every `UITextView` of the game and the game gives it no way to
 * tell the sign editor apart, so this is opt-in: other multi-line text editors are centred as well.
 * Padding and wrapping differences to iOS (item 13c) are deliberately not touched; they need device tuning.
 */
export const signEditorCentred: Patch = {
  id: 'sign-editor-centred',
  version: 1,
  nameKey: 'patch.sign-editor-centred.name',
  descriptionKey: 'patch.sign-editor-centred.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads', versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  credits: JARLPENGUIN_CREDITS,
  optIn: true,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`sign-editor-centred cannot be applied (status: ${status})`, 'cannotApply', { status });
    const site = locate(ctx)!;
    editDex('sign-editor-centred', () => {
      site.cls.patchInsns(site.method, (u) => { u[site.at + 1] = GRAVITY_CENTRED; });
      site.set.commit();
    });
    ctx.log('sign editor: text gravity changed to top-centre');
  },
};
