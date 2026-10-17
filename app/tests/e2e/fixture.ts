// Builds a tiny synthetic APK (zip + binary AndroidManifest.xml). Never uses the real game.
import { zipSync } from 'fflate';

const RES_ID = { versionCode: 0x0101021b, versionName: 0x0101021c, name: 0x01010003, theme: 0x01010000 };
const ANDROID_URI = 'http://schemas.android.com/apk/res/android';

class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { return this.u16(v & 0xffff).u16(v >>> 16); }
  get length() { return this.b.length; }
}
function chunk(type: number, headerSize: number, header: (w: W) => void, body: (w: W) => void): number[] {
  const h = new W(), b = new W();
  header(h); body(b);
  const out = new W();
  out.u16(type).u16(headerSize).u32(8 + h.length + b.length);
  return [...out.b, ...h.b, ...b.b];
}

export function buildManifest(pkg: string, versionName: string, versionCode: number): Uint8Array {
  const strings = ['versionCode', 'versionName', 'name', 'theme', 'android', ANDROID_URI, 'manifest', 'package',
    'application', 'activity', pkg, versionName, 'com.noodlecake.noodlewebview.BlockheadsWebView'];
  const idx = (s: string) => strings.indexOf(s);
  const sp = new W(); const offsets: number[] = [];
  for (const s of strings) {
    offsets.push(sp.length);
    sp.u16(s.length); for (const c of s) sp.u16(c.charCodeAt(0)); sp.u16(0);
  }
  while (sp.length % 4) sp.u8(0);
  const pool = chunk(0x0001, 28, (h) => { h.u32(strings.length).u32(0).u32(0).u32(28 + 4 * strings.length).u32(0); },
    (b) => { offsets.forEach((o) => b.u32(o)); sp.b.forEach((x) => b.u8(x)); });
  const resMap = chunk(0x0180, 8, () => {}, (b) => Object.values(RES_ID).forEach((id) => b.u32(id)));
  const ns = (type: number) => chunk(type, 16, (h) => { h.u32(1).u32(0xffffffff); }, (b) => { b.u32(idx('android')).u32(idx(ANDROID_URI)); });
  type Attr = { ns: boolean; name: string; raw?: string; type: number; data: number };
  const start = (name: string, attrs: Attr[]) => chunk(0x0102, 16, (h) => { h.u32(1).u32(0xffffffff); }, (b) => {
    b.u32(0xffffffff).u32(idx(name)).u16(0x14).u16(0x14).u16(attrs.length).u16(0).u16(0).u16(0);
    for (const a of attrs) {
      b.u32(a.ns ? idx(ANDROID_URI) : 0xffffffff).u32(idx(a.name)).u32(a.raw ? idx(a.raw) : 0xffffffff).u16(8).u8(0).u8(a.type).u32(a.data);
    }
  });
  const end = (name: string) => chunk(0x0103, 16, (h) => { h.u32(1).u32(0xffffffff); }, (b) => { b.u32(0xffffffff).u32(idx(name)); });
  const body = [
    ...ns(0x0100),
    ...start('manifest', [
      { ns: false, name: 'package', raw: pkg, type: 3, data: idx(pkg) },
      { ns: true, name: 'versionCode', type: 0x10, data: versionCode },
      { ns: true, name: 'versionName', raw: versionName, type: 3, data: idx(versionName) }
    ]),
    ...start('application', []),
    ...start('activity', [
      { ns: true, name: 'name', raw: strings[12], type: 3, data: 12 },
      { ns: true, name: 'theme', type: 0x01, data: 0x7f010001 }
    ]),
    ...end('activity'), ...end('application'), ...end('manifest'), ...ns(0x0101)
  ];
  const all = [...pool, ...resMap, ...body];
  const head = new W(); head.u16(0x0003).u16(8).u32(8 + all.length);
  return new Uint8Array([...head.b, ...all]);
}

export function buildSyntheticApk(): Uint8Array {
  return zipSync({
    'AndroidManifest.xml': [buildManifest('com.noodlecake.blockheads', '1.7.4', 1548230154), { level: 0 }],
    'classes.dex': new Uint8Array([0x64, 0x65, 0x78, 0x0a, 0, 0, 0, 0]),
    'assets/readme.txt': new TextEncoder().encode('synthetic test fixture')
  });
}
