import { ACC, CodeBuilder, type DexClass, type DexFile } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { editDex, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';
import type { DexSet } from '../dex';

export const MAIL_FIX_CLASS = 'Lcom/blockheadsclub/patch/MailLinkFix;';
const INTENT = 'Landroid/content/Intent;';
const STR = 'Ljava/lang/String;', URI = 'Landroid/net/Uri;', CHARSEQ = 'Ljava/lang/CharSequence;';
/** Classes whose startActivity is hooked: the game activity and the application (native code may use either context). */
const HOSTS = ['Lcom/apportable/activity/VerdeActivity;', 'Lcom/apportable/app/VerdeApplication;'];

/**
 * Adds `MailLinkFix.fix(Intent)`. For a `mailto:` intent whose body contains raw `&` (the join link is
 * `...join.php?id=X&name=Y`, which a mail app reads as the start of a new parameter and so cuts the link), the `&`
 * becomes `%26`. It also fixes the missing word "to" in "from your mobile device join my world".
 */
function addFix(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  // v0 uri, v1 string s, v2 index / head, v3 body, v4 temp, v5 temp, p0 = v6 intent
  const b = new CodeBuilder({ registers: 7, outs: 3 })
    .op('if-eqz', 6, 'end')
    .label('try')
    .op('invoke-virtual', m(INTENT, 'getData', URI), 6).op('move-result-object', 0).op('if-eqz', 0, 'end')
    .op('invoke-virtual', m(URI, 'toString', STR), 0).op('move-result-object', 1)
    .op('const-string', 4, dex.string('mailto:'))
    .op('invoke-virtual', m(STR, 'startsWith', 'Z', STR), 1, 4).op('move-result', 4).op('if-eqz', 4, 'end')
    .op('const-string', 4, dex.string('body='))
    .op('invoke-virtual', m(STR, 'indexOf', 'I', STR), 1, 4).op('move-result', 2).op('if-ltz', 2, 'end')
    .op('add-int/lit8', 2, 2, 5)
    .op('const/4', 4, 0)
    .op('invoke-virtual', m(STR, 'substring', STR, 'I', 'I'), 1, 4, 2).op('move-result-object', 4)
    .op('invoke-virtual', m(STR, 'substring', STR, 'I'), 1, 2).op('move-result-object', 3)
    .op('const-string', 1, dex.string('&')).op('const-string', 5, dex.string('%26'))
    .op('invoke-virtual', m(STR, 'replace', STR, CHARSEQ, CHARSEQ), 3, 1, 5).op('move-result-object', 3)
    .op('const-string', 1, dex.string('device%20join')).op('const-string', 5, dex.string('device%20to%20join'))
    .op('invoke-virtual', m(STR, 'replace', STR, CHARSEQ, CHARSEQ), 3, 1, 5).op('move-result-object', 3)
    .op('invoke-virtual', m(STR, 'concat', STR, STR), 4, 3).op('move-result-object', 4)
    .op('invoke-static', m(URI, 'parse', URI, STR), 4).op('move-result-object', 0)
    .op('invoke-virtual', m(INTENT, 'setData', INTENT, URI), 6, 0)
    .label('end')
    .label('done')
    .op('return-void')
    .label('catch').op('move-exception', 0).op('goto', 'done')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: dex.type('Ljava/lang/Throwable;'), label: 'catch' }] });
  const cls = dex.addClass({ descriptor: MAIL_FIX_CLASS, sourceFile: 'MailLinkFix.java' });
  cls.addMethod({ name: 'fix', returnType: 'V', params: [INTENT], access: ACC.PUBLIC | ACC.STATIC, code: b });
}

/** Overrides startActivity(Intent) and startActivity(Intent, Bundle): call the fix, then the superclass. */
function addHooks(dex: DexFile, cls: DexClass): void {
  const fix = dex.method(MAIL_FIX_CLASS, 'fix', 'V', [INTENT]);
  const sup = cls.superclass!;
  const one = new CodeBuilder({ registers: 3, outs: 2 })
    .op('invoke-static', fix, 2).op('invoke-super', dex.method(sup, 'startActivity', 'V', [INTENT]), 1, 2).op('return-void');
  const two = new CodeBuilder({ registers: 4, outs: 3 })
    .op('invoke-static', fix, 2).op('invoke-super', dex.method(sup, 'startActivity', 'V', [INTENT, 'Landroid/os/Bundle;']), 1, 2, 3).op('return-void');
  cls.addMethod({ name: 'startActivity', returnType: 'V', params: [INTENT], access: ACC.PUBLIC, code: one });
  cls.addMethod({ name: 'startActivity', returnType: 'V', params: [INTENT, 'Landroid/os/Bundle;'], access: ACC.PUBLIC, code: two });
}

const hooked = (c: DexClass): boolean => !!c.findMethod('startActivity', [INTENT], 'V');

function targets(set: DexSet): { dex: DexFile; cls: DexClass }[] {
  return HOSTS.map((h) => set.findClass(h)).filter((x): x is NonNullable<typeof x> => !!x);
}

function detect(ctx: PatchContext): PatchStatus {
  const set = openDexSet(ctx);
  const t = set ? targets(set) : [];
  // the activity is mandatory; the application class is hooked when present
  if (!set || !set.findClass(HOSTS[0]!)) return 'incompatible';
  return t.every((x) => hooked(x.cls)) ? 'applied' : 'notApplied';
}

export const fixEmailShareLink: Patch = {
  id: 'fix-email-share-link',
  version: 1,
  nameKey: 'patch.fix-email-share-link.name',
  descriptionKey: 'patch.fix-email-share-link.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads' },
  credits: JARLPENGUIN_CREDITS,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`fix-email-share-link cannot be applied (status: ${status})`, 'cannotApply', { status });
    const set = openDexSet(ctx)!;
    const todo = targets(set).filter((x) => !hooked(x.cls));
    editDex('fix-email-share-link', () => {
      if (!set.findClass(MAIL_FIX_CLASS)) addFix(set.findClass(HOSTS[0]!)!.dex);
      for (const x of todo) addHooks(x.dex, x.cls);
      set.commit();
    });
    ctx.log(`e-mail share: startActivity hooked in ${todo.length} classes`);
  },
};
