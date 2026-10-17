import { writeZip, setEntry, type ZipArchive } from '../src/zip';
import { build, type BEl } from './axml-builder';

export const BLOCKHEADS = 'com.noodlecake.blockheads';
const RID = { versionCode: 0x0101021b, versionName: 0x0101021c, minSdk: 0x0101020c, name: 0x01010003, theme: 0x01010000 };
export const WEBVIEW = 'com.noodlecake.noodlewebview.BlockheadsWebView';

export interface ManifestOpts {
  pkg?: string;
  versionName?: string | null;
  versionCode?: number | null;
  minSdk?: number | null;
  /** Theme reference of the web view activity; null = no theme attribute, undefined = a different theme. */
  theme?: number | null;
  activity?: boolean;
}

export function manifestTree(o: ManifestOpts = {}): BEl {
  const attrs: BEl['attrs'] = [];
  if (o.versionCode !== null) attrs.push({ name: 'versionCode', res: RID.versionCode, type: 0x10, data: o.versionCode ?? 1548230154 });
  if (o.versionName !== null) attrs.push({ name: 'versionName', res: RID.versionName, str: o.versionName ?? '1.7.4' });
  attrs.push({ name: 'package', str: o.pkg ?? BLOCKHEADS });
  const act: BEl['attrs'] = [{ name: 'name', res: RID.name, str: WEBVIEW }];
  if (o.theme !== null) act.push({ name: 'theme', res: RID.theme, type: 0x01, data: o.theme ?? 0x01030005 });
  const children: BEl[] = [];
  if (o.minSdk !== null) children.push({ name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', res: RID.minSdk, type: 0x10, data: o.minSdk ?? 21 }] });
  children.push({ name: 'application', children: o.activity === false ? [] : [{ name: 'activity', attrs: act }] });
  return { name: 'manifest', attrs, children };
}

/** Unsigned synthetic APK: a binary manifest plus a few assorted entries. */
export function makeApk(o: ManifestOpts = {}, extra: { name: string; data: Uint8Array; method?: 0 | 8 }[] = []): Uint8Array {
  const zip: ZipArchive = { entries: [] };
  setEntry(zip, { name: 'AndroidManifest.xml', data: build(manifestTree(o)), method: 8 });
  setEntry(zip, { name: 'classes.dex', data: new TextEncoder().encode('dex '.repeat(500)), method: 8 });
  setEntry(zip, { name: 'assets/blob.bin', data: new Uint8Array(100).map((_, i) => i), method: 0 });
  for (const e of extra) setEntry(zip, e);
  return writeZip(zip);
}
