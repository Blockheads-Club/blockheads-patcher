import { getEntry, peekData, setEntry } from '../zip';
import { NOTO_SANS_BOLD_B64, NOTO_SANS_ITALIC_B64, NOTO_SANS_REGULAR_B64 } from './fonts/noto-sans-data';
import { BLOCKHEADS_PACKAGE } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const INFO_PLIST = 'assets/Info.plist';
/** Bundled fonts, by file name inside `assets/`; their PostScript names are the file names without `.ttf`. */
export const FALLBACK_FONTS: ReadonlyArray<{ file: string; b64: string }> = [
  { file: 'NotoSans-Regular.ttf', b64: NOTO_SANS_REGULAR_B64 },
  { file: 'NotoSans-Bold.ttf', b64: NOTO_SANS_BOLD_B64 },
  { file: 'NotoSans-Italic.ttf', b64: NOTO_SANS_ITALIC_B64 },
];

const UI_APP_FONTS = /<key>UIAppFonts<\/key>\s*<array>/;
const dec = new TextDecoder();
const enc = new TextEncoder();

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const plistText = (ctx: PatchContext): string | undefined => {
  const e = getEntry(ctx.zip, INFO_PLIST);
  return e && dec.decode(peekData(e));
};
const listed = (plist: string, file: string): boolean => plist.includes(`<string>${file}</string>`);

function detect(ctx: PatchContext): PatchStatus {
  const plist = plistText(ctx);
  if (plist === undefined || !UI_APP_FONTS.test(plist)) return 'incompatible';
  const done = FALLBACK_FONTS.every((f) => listed(plist, f.file) && getEntry(ctx.zip, `assets/${f.file}`));
  return done ? 'applied' : 'notApplied';
}

/**
 * Apportable's CoreGraphics builds its font database from `/system/etc/fonts.xml`, taking the first text node of each
 * `<font>` as the file name. On current Android (the variable Roboto of Android 12+) the Roboto entries carry `<axis>` children, so that text is
 * `"Roboto-Regular.ttf\n   "` and the file is never opened; no `NotoSans-*`, `Roboto-*` or `DroidSans*` face gets
 * registered. Every CoreText lookup of a system face (Helvetica, Roboto, the default UI font) then ends in a font without
 * a CGFont and the game crashes in `CGFontCopyName` (store screen, then text layout in a world).
 *
 * The name substitutions CoreGraphics computes when nothing matched point at `NotoSans-Regular`, `-Bold` and `-Italic`,
 * and the last-resort lookup is `NotoSans-Bold`. This patch ships those three faces (static Noto Sans, SIL OFL 1.1) in
 * `assets/` and lists them under `UIAppFonts` in the game's `Info.plist`, which registers them at start-up. Harmless on old
 * Android, where the system's own fonts still win. Verified on 1.7.6 (Android 14, Galaxy Z Fold4).
 */
export const fixSystemFontCrash: Patch = {
  id: 'fix-system-font-crash',
  version: 1,
  nameKey: 'patch.fix-system-font-crash.name',
  descriptionKey: 'patch.fix-system-font-crash.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE },
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') {
      throw new PatchError(`fix-system-font-crash cannot be applied (status: ${status})`, 'cannotApply', { status });
    }
    let plist = plistText(ctx)!;
    const missing = FALLBACK_FONTS.filter((f) => !listed(plist, f.file));
    plist = plist.replace(UI_APP_FONTS, (m) => m + missing.map((f) => `\n\t\t<string>${f.file}</string>`).join(''));
    setEntry(ctx.zip, { name: INFO_PLIST, data: enc.encode(plist) });
    for (const f of FALLBACK_FONTS) setEntry(ctx.zip, { name: `assets/${f.file}`, data: decodeB64(f.b64) });
    ctx.log(`fix-system-font-crash: bundled ${FALLBACK_FONTS.map((f) => f.file).join(', ')}`);
  },
};
