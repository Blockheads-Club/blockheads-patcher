import { haveApk } from './helpers';
import { describe, it, expect, onTestFinished } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import {
  parseAxml, serializeAxml, findElements, findElementsByName, getAttr, setAttrValue, setAttrString, addAttr, manifestInfo,
  ValueType, ANDROID_NS, AxmlError,
} from '../src/axml';

const APK = '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk';
const AAPT2 = join(homedir(), 'Android/Sdk/build-tools/35.0.0/aapt2');
const have = haveApk(APK);
const ACTIVITY = 'com.noodlecake.noodlewebview.BlockheadsWebView';

function loadManifest(): Uint8Array {
  const files = unzipSync(readFileSync(APK), { filter: (f) => f.name === 'AndroidManifest.xml' });
  return files['AndroidManifest.xml']!;
}

describe('axml (real APK)', () => {
  it.skipIf(!have)('round-trips byte-identically', () => {
    const m = loadManifest();
    const out = serializeAxml(parseAxml(m));
    expect(out.length).toBe(m.length);
    expect(Buffer.from(out).equals(Buffer.from(m))).toBe(true);
  });

  it.skipIf(!have)('extracts manifest info', () => {
    const info = manifestInfo(parseAxml(loadManifest()));
    expect(info.package).toBe('com.noodlecake.blockheads');
    expect(info.versionName).toBe('1.7.4');
    expect(info.versionCode).toBe(1548230154);
    expect(typeof info.minSdk).toBe('number');
    expect(typeof info.targetSdk).toBe('number');
  });

  it.skipIf(!have)('changes only the theme reference of BlockheadsWebView', () => {
    const orig = loadManifest();
    const doc = parseAxml(orig);
    const [act] = findElementsByName(doc, 'activity', ACTIVITY);
    expect(act).toBeDefined();
    const theme = getAttr(act!, 'theme', ANDROID_NS, 0x01010000)!;
    expect(theme.valueType).toBe(ValueType.Reference);
    setAttrValue(doc, theme, ValueType.Reference, 0x01030011);
    const out = serializeAxml(doc);
    expect(out.length).toBe(orig.length);
    const diff: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i] !== orig[i]) diff.push(i);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.length).toBeLessThanOrEqual(4);
    const re = parseAxml(out);
    const a2 = getAttr(findElementsByName(re, 'activity', ACTIVITY)[0]!, 'theme', ANDROID_NS, 0x01010000)!;
    expect(a2.data).toBe(0x01030011);

    if (existsSync(AAPT2)) {
      const dir = mkdtempSync(join(tmpdir(), 'axml-'));
      // aapt2 dump xmltree needs an APK; wrap manifest in a zip
      const apk = join(dir, 'm.apk');
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(apk, zipSync({ 'AndroidManifest.xml': [out, { level: 0 }] }));
      const txt = execFileSync(AAPT2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], { encoding: 'utf8' });
      const idx = txt.indexOf(ACTIVITY);
      expect(idx).toBeGreaterThan(0);
      expect(txt.slice(Math.max(0, idx - 400), idx + 600)).toMatch(/theme.*(0x01030011|Theme\.Translucent\.NoTitleBar\.Fullscreen)/);
    }
  });

  it.skipIf(!have)('addAttr + new strings survive reparse and keep sort order', () => {
    const doc = parseAxml(loadManifest());
    const act = findElementsByName(doc, 'activity', ACTIVITY)[0]!;
    const before = act.attributes.length;
    const at = addAttr(doc, act, { nsUri: ANDROID_NS, name: 'label', resourceId: 0x01010001, rawValue: 'Hello', valueType: ValueType.String, data: 0 });
    expect(at.stringValue).toBe('Hello');
    const re = parseAxml(serializeAxml(doc));
    const act2 = findElementsByName(re, 'activity', ACTIVITY)[0]!;
    expect(act2.attributes.length).toBe(before + 1);
    const ids = act2.attributes.map((a) => a.resourceId).filter((x): x is number => x !== null);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(getAttr(act2, 'label', ANDROID_NS, 0x01010001)!.stringValue).toBe('Hello');
    expect(manifestInfo(re).package).toBe('com.noodlecake.blockheads');
    // other string attributes still resolve after index shifting
    expect(findElementsByName(re, 'activity', ACTIVITY).length).toBe(1);
    // second round trip stable
    const again = serializeAxml(re);
    expect(Buffer.from(again).equals(Buffer.from(serializeAxml(doc)))).toBe(true);
  });

  it.skipIf(!have)('setAttrString changes a string value', () => {
    const doc = parseAxml(loadManifest());
    const root = doc.root;
    const vn = getAttr(root, 'versionName', ANDROID_NS)!;
    setAttrString(doc, vn, '9.9.9');
    expect(manifestInfo(parseAxml(serializeAxml(doc))).versionName).toBe('9.9.9');
  });

  it.skipIf(!have)('findElements gives paths', () => {
    const doc = parseAxml(loadManifest());
    const acts = findElements(doc, (e, p) => e.name === 'activity' && p.join('/') === 'manifest/application/activity');
    expect(acts.length).toBeGreaterThan(0);
  });
});

describe('axml (errors)', () => {
  it('rejects garbage', () => {
    expect(() => parseAxml(new Uint8Array([1, 2, 3]))).toThrow(AxmlError);
    expect(() => parseAxml(new Uint8Array(32))).toThrow(AxmlError);
  });
});

// ---- synthetic AXML with a CDATA node: covers insertStringAt's CDATA index shifting ----
function buildCdataAxml(): Uint8Array {
  const strings = ['label', 'http://schemas.android.com/apk/res/android', 'android', 'manifest', 'hello cdata'];
  const sBytes: number[] = [];
  const offsets: number[] = [];
  for (const s of strings) {
    offsets.push(sBytes.length);
    sBytes.push(s.length & 0xff, s.length >> 8);
    for (const ch of s) sBytes.push(ch.charCodeAt(0), 0);
    sBytes.push(0, 0);
  }
  while (sBytes.length % 4) sBytes.push(0);
  const stringsStart = 28 + strings.length * 4;
  const pool = new Uint8Array(stringsStart + sBytes.length);
  const pv = new DataView(pool.buffer);
  pv.setUint16(0, 1, true); pv.setUint16(2, 28, true); pv.setUint32(4, pool.length, true);
  pv.setUint32(8, strings.length, true); pv.setUint32(12, 0, true); pv.setUint32(16, 0, true);
  pv.setUint32(20, stringsStart, true); pv.setUint32(24, 0, true);
  offsets.forEach((o, i) => pv.setUint32(28 + i * 4, o, true));
  pool.set(sBytes, stringsStart);

  const resMap = new Uint8Array(12);
  const rv = new DataView(resMap.buffer);
  rv.setUint16(0, 0x180, true); rv.setUint16(2, 8, true); rv.setUint32(4, 12, true); rv.setUint32(8, 0x01010001, true);

  const node = (type: number, size: number, body: number[]): Uint8Array => {
    const c = new Uint8Array(size);
    const dv = new DataView(c.buffer);
    dv.setUint16(0, type, true); dv.setUint16(2, 16, true); dv.setUint32(4, size, true);
    dv.setUint32(8, 1, true); dv.setUint32(12, 0xffffffff, true);
    body.forEach((v, i) => dv.setUint32(16 + i * 4, v >>> 0, true));
    return c;
  };
  const startEl = node(0x102, 36, [0xffffffff, 3]);
  new DataView(startEl.buffer).setUint16(24, 20, true); // attributeStart
  new DataView(startEl.buffer).setUint16(26, 20, true); // attributeSize
  const mkCdata = (): Uint8Array => {
    const c = node(0x104, 28, [4]);
    c.set([8, 0, 0, 0x03, 4, 0, 0, 0], 20); // Res_value: size 8, res0, type string, data 4
    return c;
  };
  // one CDATA outside the root element (document level) and one inside it
  const chunks = [pool, resMap, node(0x100, 24, [2, 1]), mkCdata(), startEl, mkCdata(), node(0x103, 24, [0xffffffff, 3]), node(0x101, 24, [2, 1])];
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint16(0, 3, true); ov.setUint16(2, 8, true); ov.setUint32(4, total, true);
  let o = 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Reads every string of the (UTF-16) pool plus the string indices used by CDATA chunks. */
function inspectCdata(bytes: Uint8Array): { strings: string[]; cdataData: number[]; cdataTyped: number[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const strings: string[] = [], cdataData: number[] = [], cdataTyped: number[] = [];
  for (let off = 8; off < bytes.length; off += dv.getUint32(off + 4, true)) {
    const type = dv.getUint16(off, true);
    if (type === 1) {
      const count = dv.getUint32(off + 8, true), start = dv.getUint32(off + 20, true);
      for (let i = 0; i < count; i++) {
        const p = off + start + dv.getUint32(off + 28 + i * 4, true);
        const len = dv.getUint16(p, true);
        strings.push(String.fromCharCode(...new Uint16Array(bytes.slice(p + 2, p + 2 + len * 2).buffer)));
      }
    } else if (type === 0x104) {
      cdataData.push(dv.getUint32(off + 16, true));
      cdataTyped.push(dv.getUint32(off + 24, true));
    }
  }
  return { strings, cdataData, cdataTyped };
}

describe('axml insertStringAt (synthetic CDATA fixture)', () => {
  it('round-trips the fixture unchanged', () => {
    const src = buildCdataAxml();
    expect(Array.from(serializeAxml(parseAxml(src)))).toEqual(Array.from(src));
  });

  it('shifts CDATA string references when an id-bearing attribute name is inserted into the pool', () => {
    const doc = parseAxml(buildCdataAxml());
    const before = inspectCdata(serializeAxml(doc));
    expect(before.strings[before.cdataData[0]!]).toBe('hello cdata');
    addAttr(doc, doc.root, { nsUri: ANDROID_NS, name: 'versionCode', resourceId: 0x0101021b, rawValue: null, valueType: ValueType.IntDec, data: 7 });
    const out = serializeAxml(doc);
    const after = inspectCdata(out);
    expect(after.strings.length).toBe(before.strings.length + 1);
    expect(after.strings[1]).toBe('versionCode'); // inserted right after the resource-mapped names
    expect(after.cdataData).toHaveLength(2); // document-level and element-level
    for (let i = 0; i < 2; i++) {
      expect(after.cdataData[i]).toBe(before.cdataData[i]! + 1);
      expect(after.cdataTyped[i]).toBe(before.cdataTyped[i]! + 1);
      expect(after.strings[after.cdataData[i]!]).toBe('hello cdata');
      expect(after.strings[after.cdataTyped[i]!]).toBe('hello cdata');
    }
    expect(getAttr(parseAxml(out).root, 'versionCode')?.data).toBe(7);
  });
});
