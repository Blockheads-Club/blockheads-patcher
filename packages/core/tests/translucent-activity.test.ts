import { describe, it, expect } from 'vitest';
import {
  parseAxml, getAttr, findElements, ANDROID_NS, ValueType, PatchError, defaultRegistry, JARLPENGUIN_CREDITS, makeTranslucentActivityPatch,
  fixTextActivityFreeze, fixWelcomePopupDeadlock, THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN, ANDROID_THEME_ATTR_ID, type PatchContext,
} from '../src';
import { build, type BEl } from './axml-builder';

const TEXT = 'com.apportable.ui.TextViewHaxActivity';
const NAME = { name: 'name', res: 0x01010003 };
type Attrs = NonNullable<BEl['attrs']>;
const tree = (activities: Attrs[]): BEl => ({
  name: 'manifest', attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }],
  children: [{ name: 'application', children: activities.map((attrs) => ({ name: 'activity', attrs })) }],
});
const ctxOf = (t: BEl) => {
  const doc = parseAxml(build(t));
  let dirty = 0;
  const logs: string[] = [];
  const ctx: PatchContext = { zip: { entries: [] }, manifest: doc, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty: () => { dirty++; }, log: (m) => logs.push(m) };
  return { ctx, doc, dirty: () => dirty, logs };
};
const theme = (doc: ReturnType<typeof parseAxml>, i: number) => getAttr(findElements(doc, (e) => e.name === 'activity')[i]!, 'theme', ANDROID_NS, ANDROID_THEME_ATTR_ID);

describe('fix-text-activity-freeze', () => {
  it('is registered, credited and on by default', () => {
    expect(defaultRegistry.get('fix-text-activity-freeze')).toBe(fixTextActivityFreeze);
    expect(fixTextActivityFreeze.credits).toBe(JARLPENGUIN_CREDITS);
    expect(fixTextActivityFreeze.optIn).toBeUndefined();
    expect(fixWelcomePopupDeadlock.credits).toBeUndefined();
  });
  it('is incompatible when the activity is missing', () => {
    const t = ctxOf(tree([[{ ...NAME, str: 'com.other.Activity' }]]));
    expect(fixTextActivityFreeze.detect(t.ctx)).toBe('incompatible');
    expect(() => fixTextActivityFreeze.apply(t.ctx)).toThrow(PatchError);
    expect(t.dirty()).toBe(0);
  });
  it('adds the theme when absent, once', () => {
    const t = ctxOf(tree([[{ ...NAME, str: TEXT }]]));
    expect(fixTextActivityFreeze.detect(t.ctx)).toBe('notApplied');
    fixTextActivityFreeze.apply(t.ctx);
    expect(t.dirty()).toBe(1);
    expect(t.logs[0]).toContain('TextViewHaxActivity');
    const a = theme(t.doc, 0)!;
    expect([a.valueType, a.data]).toEqual([ValueType.Reference, THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN]);
    expect(fixTextActivityFreeze.detect(t.ctx)).toBe('applied');
    expect(() => fixTextActivityFreeze.apply(t.ctx)).toThrow(/status: applied/);
  });
  it('replaces another theme and ignores a differently typed one', () => {
    const t = ctxOf(tree([[{ ...NAME, str: TEXT }, { name: 'theme', res: ANDROID_THEME_ATTR_ID, type: 0x01, data: 0x7f060018 }]]));
    expect(fixTextActivityFreeze.detect(t.ctx)).toBe('notApplied');
    fixTextActivityFreeze.apply(t.ctx);
    expect(theme(t.doc, 0)!.data).toBe(THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN);
    const u = ctxOf(tree([[{ ...NAME, str: TEXT }, { name: 'theme', res: ANDROID_THEME_ATTR_ID, type: 0x10, data: THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN }]]));
    expect(fixTextActivityFreeze.detect(u.ctx)).toBe('notApplied');
  });
});

describe('makeTranslucentActivityPatch', () => {
  const rel = makeTranslucentActivityPatch({ id: 'rel', activity: 'com.noodlecake.blockheads.Rel', optIn: true, logMessage: 'ok' });
  it('matches relative names, skips unnamed or other activities and carries optIn', () => {
    expect(rel.optIn).toBe(true);
    expect(rel.credits).toBeUndefined();
    const t = ctxOf(tree([[], [{ ...NAME, str: 'plain.Other' }], [{ ...NAME, str: '.Other' }], [{ ...NAME, str: '.Rel' }]]));
    expect(rel.detect(t.ctx)).toBe('notApplied');
    rel.apply(t.ctx);
    expect(theme(t.doc, 3)).toBeDefined();
    expect([0, 1, 2].map((i) => theme(t.doc, i))).toEqual([undefined, undefined, undefined]);
  });
});
