import {
  ANDROID_NS, ValueType, getAttr, insertElement, removeElement, setAttrValue, addAttr,
  type AxmlElement, type ElementSpec,
} from '../axml';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, MAIN_ACTIVITY, findActivityByName } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

const ID_NAME = 0x01010003, ID_SCHEME = 0x01010027, ID_HOST = 0x01010028, ID_PATH = 0x0101002a, ID_EXPORTED = 0x01010010;
const VIEW = 'android.intent.action.VIEW';

export const JOIN_SCHEME = 'blockheads';
export const JOIN_HOSTS = ['theblockheads.net', 'blockheads.noodlecake.com'] as const;
export const JOIN_PATH = '/join.php';

const str = (name: string, resourceId: number, value: string) => ({ name, nsUri: ANDROID_NS, resourceId, value });
const named = (tag: string, value: string): ElementSpec => ({ name: tag, attributes: [str('name', ID_NAME, value)] });
const dataSpec = (attrs: { name: string; id: number; value: string }[]): ElementSpec => ({
  name: 'data', attributes: attrs.map((a) => str(a.name, a.id, a.value)),
});
const filter = (data: ElementSpec[]): ElementSpec => ({
  name: 'intent-filter',
  children: [
    named('action', VIEW), named('category', 'android.intent.category.DEFAULT'), named('category', 'android.intent.category.BROWSABLE'), ...data,
  ],
});

/**
 * The two correct filters. Android merges all `<data>` elements of one filter into the cross product of their
 * schemes x hosts x paths, so the web filter lists both schemes and both hosts once. `android:autoVerify` is left
 * unset (false): domain verification needs a Digital Asset Links file on the server, which we do not control.
 */
export function joinLinkFilters(): ElementSpec[] {
  return [
    filter([dataSpec([{ name: 'scheme', id: ID_SCHEME, value: JOIN_SCHEME }])]),
    filter([
      dataSpec([{ name: 'scheme', id: ID_SCHEME, value: 'http' }]),
      dataSpec([{ name: 'scheme', id: ID_SCHEME, value: 'https' }]),
      ...JOIN_HOSTS.map((h) => dataSpec([{ name: 'host', id: ID_HOST, value: h }])),
      dataSpec([{ name: 'path', id: ID_PATH, value: JOIN_PATH }]),
    ]),
  ];
}

const strAttr = (el: AxmlElement, name: string, id: number): string | undefined => getAttr(el, name, ANDROID_NS, id)?.stringValue;
const isView = (f: AxmlElement): boolean =>
  f.children.some((c) => c.name === 'action' && strAttr(c, 'name', ID_NAME) === VIEW);
const dataOf = (f: AxmlElement, name: string, id: number): string[] =>
  f.children.filter((c) => c.name === 'data').map((c) => strAttr(c, name, id)).filter((v): v is string => v !== undefined);
const viewFilters = (act: AxmlElement): AxmlElement[] => act.children.filter((c) => c.name === 'intent-filter' && isView(c));
const dataFilters = (act: AxmlElement): AxmlElement[] => viewFilters(act).filter((f) => f.children.some((c) => c.name === 'data'));

const sameSet = (a: string[], b: readonly string[]): boolean => new Set(a).size === b.length && b.every((v) => a.includes(v));
const hasCategories = (f: AxmlElement): boolean => {
  const cats = f.children.filter((c) => c.name === 'category').map((c) => strAttr(c, 'name', ID_NAME));
  return cats.includes('android.intent.category.DEFAULT') && cats.includes('android.intent.category.BROWSABLE');
};
const isSchemeFilter = (f: AxmlElement): boolean =>
  hasCategories(f) && sameSet(dataOf(f, 'scheme', ID_SCHEME), [JOIN_SCHEME]) && dataOf(f, 'host', ID_HOST).length === 0;
const isWebFilter = (f: AxmlElement): boolean =>
  hasCategories(f) && sameSet(dataOf(f, 'scheme', ID_SCHEME), ['http', 'https']) && sameSet(dataOf(f, 'host', ID_HOST), JOIN_HOSTS) &&
  sameSet(dataOf(f, 'path', ID_PATH), [JOIN_PATH]);

function detect(ctx: PatchContext): PatchStatus {
  const act = findActivityByName(ctx, MAIN_ACTIVITY);
  if (!act) return 'incompatible';
  const filters = dataFilters(act);
  return filters.length === 2 && filters.some(isSchemeFilter) && filters.some(isWebFilter) ? 'applied' : 'notApplied';
}

/**
 * Join links (`blockheads://...` and `http://theblockheads.net/join.php?...`) never reached the game because its VIEW
 * intent filters are malformed (scheme `theblockheads.net/join`, which is not a scheme; a web filter without a path and
 * with a stray text node). The activity forwards `Intent.getDataString()` unchanged to the native handler, both on cold
 * start (onCreate) and for a running instance (onNewIntent, launchMode singleTask), so the filters only have to route the
 * URI. This replaces the broken data filters with a custom-scheme filter and an http/https filter for `/join.php`.
 * Needs a device test: whether the native parser accepts the string exactly as delivered.
 */
export const fixJoinLinks: Patch = {
  id: 'fix-join-links',
  version: 1,
  nameKey: 'patch.fix-join-links.name',
  descriptionKey: 'patch.fix-join-links.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE, versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  credits: JARLPENGUIN_CREDITS,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`fix-join-links cannot be applied (status: ${status})`, 'cannotApply', { status });
    const act = findActivityByName(ctx, MAIN_ACTIVITY)!;
    const old = dataFilters(act);
    const at = old.length ? act.children.indexOf(old[0]!) : act.children.length;
    for (const f of old) removeElement(ctx.manifest, act, f);
    joinLinkFilters().forEach((spec, i) => insertElement(ctx.manifest, act, spec, at + i));
    // The activity has intent filters and must be reachable from other apps; say so explicitly (required from API 31).
    const exported = getAttr(act, 'exported', ANDROID_NS, ID_EXPORTED);
    if (!exported) addAttr(ctx.manifest, act, { nsUri: ANDROID_NS, name: 'exported', resourceId: ID_EXPORTED, rawValue: null, valueType: ValueType.IntBoolean, data: 0xffffffff });
    else if (exported.data === 0) setAttrValue(ctx.manifest, exported, ValueType.IntBoolean, 0xffffffff);
    ctx.markManifestDirty();
    ctx.log(`fix-join-links: replaced ${old.length} intent filter(s) with 2`);
  },
};

