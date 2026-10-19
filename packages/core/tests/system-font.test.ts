import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  loadApk, applyPatches, createRegistry, defaultRegistry, PatchError, fixSystemFontCrash, FALLBACK_FONTS, INFO_PLIST,
  type PatchContext,
} from '../src';
import { getEntry, readZip, writeZip } from '../src/zip';
import { makeApk } from './synthetic-apk';
import { haveApk } from './helpers';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>UIAppFonts</key>
\t<array>
\t\t<string>BlockheadsFont-Regular.otf</string>
\t</array>
</dict>
</plist>
`;
const plistEntry = (text: string) => ({ name: INFO_PLIST, data: enc.encode(text) });
const reg = createRegistry([fixSystemFontCrash]);
const logs: string[] = [];
const ctxOf = async (bytes: Uint8Array): Promise<PatchContext> => {
  const a = await loadApk(bytes);
  return { zip: a.zip, manifest: a.manifest, info: a.info, markManifestDirty: () => {}, log: (m) => logs.push(m) };
};

/** A minimal TrueType reader: PostScript name (name id 6, Windows platform) and whether the font is variable. */
function fontInfo(data: Uint8Array): { psName: string; variable: boolean } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0; i < v.getUint16(4); i++) {
    const at = 12 + 16 * i;
    tables.set(String.fromCharCode(...data.subarray(at, at + 4)), v.getUint32(at + 8));
  }
  const name = tables.get('name')!;
  const count = v.getUint16(name + 2), strings = name + v.getUint16(name + 4);
  for (let i = 0; i < count; i++) {
    const r = name + 6 + 12 * i;
    if (v.getUint16(r) !== 3 || v.getUint16(r + 6) !== 6) continue;
    const off = strings + v.getUint16(r + 10), len = v.getUint16(r + 8);
    let psName = '';
    for (let j = 0; j < len; j += 2) psName += String.fromCharCode(v.getUint16(off + j));
    return { psName, variable: tables.has('fvar') };
  }
  throw new Error('no PostScript name');
}

describe('fix-system-font-crash', () => {
  it('bundles the three static Noto Sans faces under the PostScript names CoreGraphics falls back to', () => {
    expect(FALLBACK_FONTS.map((f) => f.file)).toEqual(['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf']);
    for (const f of FALLBACK_FONTS) {
      const bytes = Uint8Array.from(Buffer.from(f.b64, 'base64'));
      expect(fontInfo(bytes)).toEqual({ psName: f.file.replace('.ttf', ''), variable: false });
    }
  });

  it('is incompatible without an Info.plist or without UIAppFonts', async () => {
    expect(fixSystemFontCrash.detect(await ctxOf(makeApk()))).toBe('incompatible');
    const noFonts = await ctxOf(makeApk({}, [plistEntry('<plist><dict></dict></plist>')]));
    expect(fixSystemFontCrash.detect(noFonts)).toBe('incompatible');
    expect(() => fixSystemFontCrash.apply(noFonts)).toThrow(PatchError);
  });

  it('adds the fonts and their UIAppFonts entries, then reports applied', async () => {
    const apk = await loadApk(makeApk({}, [plistEntry(PLIST)]));
    expect(applyPatches(apk, ['fix-system-font-crash'], reg).applied).toEqual(['fix-system-font-crash']);
    const out = readZip(writeZip(apk.zip));
    const plist = dec.decode(getEntry(out, INFO_PLIST)!.data);
    expect(plist).toContain(
      '<array>\n\t\t<string>NotoSans-Regular.ttf</string>\n\t\t<string>NotoSans-Bold.ttf</string>\n\t\t<string>NotoSans-Italic.ttf</string>\n\t\t<string>BlockheadsFont-Regular.otf</string>',
    );
    for (const f of FALLBACK_FONTS) {
      expect(Buffer.from(getEntry(out, `assets/${f.file}`)!.data).toString('base64')).toBe(f.b64);
    }
    const ctx = await ctxOf(writeZip(apk.zip));
    expect(fixSystemFontCrash.detect(ctx)).toBe('applied');
    expect(() => fixSystemFontCrash.apply(ctx)).toThrow(/status: applied/);
  });

  it('completes a partial install without listing a font twice', async () => {
    const partial = PLIST.replace('<array>', '<array>\n\t\t<string>NotoSans-Bold.ttf</string>');
    const ctx = await ctxOf(makeApk({}, [plistEntry(partial)]));
    expect(fixSystemFontCrash.detect(ctx)).toBe('notApplied');
    fixSystemFontCrash.apply(ctx);
    expect(logs.at(-1)).toBe('fix-system-font-crash: bundled NotoSans-Regular.ttf, NotoSans-Bold.ttf, NotoSans-Italic.ttf');
    const plist = dec.decode(getEntry(ctx.zip, INFO_PLIST)!.data);
    expect(plist.split('NotoSans-Bold.ttf').length - 1).toBe(1);
    expect(fixSystemFontCrash.detect(ctx)).toBe('applied');
  });

  it('is recommended (not opt-in) and registered by default', () => {
    expect(defaultRegistry.get('fix-system-font-crash')).toBe(fixSystemFontCrash);
    expect(fixSystemFontCrash.optIn).toBeUndefined();
  });
});

const REAL = [
  '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk',
  '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk',
  process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk',
];
for (const path of REAL) {
  describe.skipIf(!haveApk(path))(`fix-system-font-crash on ${path.split('/').pop()}`, () => {
    it('applies to the real Info.plist and changes only it plus the added fonts', async () => {
      const original = new Uint8Array(readFileSync(path));
      const ctx = await ctxOf(original);
      expect(fixSystemFontCrash.detect(ctx)).toBe('notApplied');
      fixSystemFontCrash.apply(ctx);
      const before = readZip(original), after = readZip(writeZip(ctx.zip));
      const sha = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');
      const changed = after.entries.filter((e) => sha(e.data) !== sha(getEntry(before, e.name)?.data ?? new Uint8Array())).map((e) => e.name);
      expect(changed.sort()).toEqual([INFO_PLIST, ...FALLBACK_FONTS.map((f) => `assets/${f.file}`)].sort());
      expect(dec.decode(getEntry(after, INFO_PLIST)!.data)).toMatch(/<string>NotoSans-Italic\.ttf<\/string>\s*<string>BlockheadsFont-Regular\.otf<\/string>/);
    });
  });
}
