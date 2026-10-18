import { describe, it, expect } from 'vitest';
import {
  parseAxml, serializeAxml, getAttr, findElements, ANDROID_NS, ValueType, PatchError, fixJoinLinks, joinLinkFilters, defaultRegistry,
  JARLPENGUIN_CREDITS, MAIN_ACTIVITY, BLOCKHEADS_PACKAGE, type PatchContext, type AxmlElement,
} from '../src';
import { build, type BEl } from './axml-builder';

const NAME = { name: 'name', res: 0x01010003 };
const el = (tag: string, value: string): BEl => ({ name: tag, attrs: [{ ...NAME, str: value }] });
const data = (a: Record<string, string>): BEl => ({
  name: 'data', attrs: Object.entries(a).map(([k, v]) => ({ name: k, res: k === 'scheme' ? 0x01010027 : k === 'host' ? 0x01010028 : 0x0101002a, str: v })),
});
const filter = (children: BEl[], texts: BEl['texts'] = []): BEl => ({ name: 'intent-filter', children, texts });
const cats = [el('category', 'android.intent.category.DEFAULT'), el('category', 'android.intent.category.BROWSABLE')];
const view = el('action', 'android.intent.action.VIEW');
const broken = (): BEl[] => [
  filter([view, ...cats, data({ scheme: 'theblockheads.net/join' })]),
  filter([view, ...cats, data({ scheme: 'theblockheads.net/join' })]),
  filter([el('action', 'android.intent.action.MAIN'), el('category', 'android.intent.category.LAUNCHER')]),
  filter([el('action', 'android.net.conn.CONNECTIVITY_CHANGE')]),
  filter([view, ...cats, data({ scheme: 'http' }), data({ host: 'theblockheads.net' })], [{ pos: 2, value: '"\n' }]),
];
const tree = (o: { filters?: BEl[]; actAttrs?: BEl['attrs']; noActivity?: boolean } = {}): BEl => ({
  name: 'manifest', attrs: [{ name: 'package', str: BLOCKHEADS_PACKAGE }],
  children: [{ name: 'application', children: o.noActivity ? [] : [{ name: 'activity', attrs: [{ ...NAME, str: MAIN_ACTIVITY }, ...(o.actAttrs ?? [])], children: o.filters ?? broken() }] }],
});
const ctxOf = (t: BEl) => {
  const doc = parseAxml(build(t));
  let dirty = 0;
  const ctx: PatchContext = { zip: { entries: [] }, manifest: doc, info: { packageName: BLOCKHEADS_PACKAGE, sha256: '' }, markManifestDirty: () => { dirty++; }, log() {} };
  return { ctx, doc, dirty: () => dirty };
};
const activity = (doc: ReturnType<typeof parseAxml>): AxmlElement => findElements(doc, (e) => e.name === 'activity')[0]!;
const sa = (e: AxmlElement, n: string, id: number) => getAttr(e, n, ANDROID_NS, id)?.stringValue;
const actions = (f: AxmlElement) => f.children.filter((c) => c.name === 'action').map((c) => sa(c, 'name', 0x01010003));

describe('fix-join-links', () => {
  it('replaces the malformed filters, keeps unrelated ones and their order, and is idempotent', () => {
    const t = ctxOf(tree());
    expect(fixJoinLinks.detect(t.ctx)).toBe('notApplied');
    fixJoinLinks.apply(t.ctx);
    expect(t.dirty()).toBe(1);
    expect(fixJoinLinks.detect(t.ctx)).toBe('applied');
    expect(() => fixJoinLinks.apply(t.ctx)).toThrow(PatchError);
    const again = parseAxml(serializeAxml(t.doc));
    expect(fixJoinLinks.detect({ ...t.ctx, manifest: again })).toBe('applied');
    const filters = activity(again).children;
    expect(filters.map((f) => actions(f)[0]?.split('.').pop())).toEqual(['VIEW', 'VIEW', 'MAIN', 'CONNECTIVITY_CHANGE']);
    const [scheme, web] = filters as [AxmlElement, AxmlElement];
    expect(scheme.children.map((c) => c.name)).toEqual(['action', 'category', 'category', 'data']);
    expect(sa(scheme.children[3]!, 'scheme', 0x01010027)).toBe('blockheads');
    const hosts = web.children.filter((c) => c.name === 'data').map((c) => sa(c, 'host', 0x01010028)).filter(Boolean);
    expect(hosts).toEqual(['theblockheads.net', 'blockheads.noodlecake.com']);
    expect(web.children.map((c) => sa(c, 'path', 0x0101002a)).filter(Boolean)).toEqual(['/join.php']);
    const act = activity(again);
    expect(getAttr(act, 'exported', ANDROID_NS, 0x01010010)?.data).toBe(0xffffffff);
    expect(serializeAxml(again)).toEqual(serializeAxml(parseAxml(serializeAxml(again))));
  });

  it('inserts at the end when no data filter exists and fixes an exported=false activity', () => {
    const t = ctxOf(tree({ filters: [filter([el('action', 'android.intent.action.MAIN')])], actAttrs: [{ name: 'exported', res: 0x01010010, type: 0x12, data: 0 }] }));
    expect(fixJoinLinks.detect(t.ctx)).toBe('notApplied');
    fixJoinLinks.apply(t.ctx);
    expect(activity(t.doc).children.length).toBe(3);
    expect(getAttr(activity(t.doc), 'exported', ANDROID_NS, 0x01010010)).toMatchObject({ valueType: ValueType.IntBoolean, data: 0xffffffff });
  });

  it('leaves exported=true alone', () => {
    const t = ctxOf(tree({ actAttrs: [{ name: 'exported', res: 0x01010010, type: 0x12, data: 0xffffffff }] }));
    fixJoinLinks.apply(t.ctx);
    expect(getAttr(activity(t.doc), 'exported', ANDROID_NS, 0x01010010)?.data).toBe(0xffffffff);
  });

  it('is incompatible without the game activity', () => {
    const t = ctxOf(tree({ noActivity: true }));
    expect(fixJoinLinks.detect(t.ctx)).toBe('incompatible');
    expect(() => fixJoinLinks.apply(t.ctx)).toThrow(PatchError);
  });

  it('does not consider near-misses applied', () => {
    const web = (extra: BEl[], c: BEl[] = cats): BEl => filter([view, ...c, data({ scheme: 'http' }), data({ scheme: 'https' }), data({ host: 'theblockheads.net' }), data({ host: 'blockheads.noodlecake.com' }), ...extra]);
    const scheme = (c: BEl[] = cats, extra: BEl[] = []): BEl => filter([view, ...c, data({ scheme: 'blockheads' }), ...extra]);
    const path = data({ path: '/join.php' });
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme(), web([path])] })).ctx)).toBe('applied');
    // missing BROWSABLE, wrong path, extra host on the scheme filter, a third data filter, only one filter, scheme+http mix
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme([cats[0]!]), web([path])] })).ctx)).toBe('notApplied');
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme(), web([data({ path: '/x' })])] })).ctx)).toBe('notApplied');
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme(cats, [data({ host: 'x' })]), web([path])] })).ctx)).toBe('notApplied');
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme(), web([path]), scheme()] })).ctx)).toBe('notApplied');
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme()] })).ctx)).toBe('notApplied');
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [web([path]), web([path])] })).ctx)).toBe('notApplied');
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme(), web([])] })).ctx)).toBe('notApplied');
    // data elements without usable attributes, non-VIEW filters ignored
    expect(fixJoinLinks.detect(ctxOf(tree({ filters: [scheme(), web([path]), filter([el('action', 'x'), data({})])] })).ctx)).toBe('applied');
  });

  it('exposes credits, metadata and registration', () => {
    expect(fixJoinLinks.credits).toBe(JARLPENGUIN_CREDITS);
    expect(fixJoinLinks.optIn).toBeUndefined();
    expect(fixJoinLinks.appliesTo.versionNames).toEqual(['1.7.4', '1.7.5', '1.7.6']);
    expect(defaultRegistry.get('fix-join-links')).toBe(fixJoinLinks);
    expect(joinLinkFilters()).toHaveLength(2);
  });
});
