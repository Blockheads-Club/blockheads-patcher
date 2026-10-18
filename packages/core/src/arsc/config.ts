/**
 * ResTable_config helpers. A config is kept as its raw bytes (so unknown/newer fields survive); the helpers read the
 * classic fields by offset and can build new configs of the minimal 28-byte layout.
 */

export const DENSITY = { ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640, anydpi: 0xfffe, nodpi: 0xffff } as const;

/** ConfigDescription "configuration changed" flags used in typeSpec entries. */
export const CONFIG_CHANGE = {
  mcc: 0x1, mnc: 0x2, locale: 0x4, touchscreen: 0x8, keyboard: 0x10, keyboardHidden: 0x20, navigation: 0x40, orientation: 0x80,
  density: 0x100, screenSize: 0x200, version: 0x400, screenLayout: 0x800, uiMode: 0x1000, smallestScreenSize: 0x2000,
} as const;

export interface ArscConfigFields {
  mcc: number; mnc: number;
  language: string; country: string;
  orientation: number; touchscreen: number; density: number;
  keyboard: number; navigation: number; inputFlags: number;
  screenWidth: number; screenHeight: number;
  sdkVersion: number; minorVersion: number;
  screenLayout: number; uiMode: number; smallestScreenWidthDp: number;
  screenWidthDp: number; screenHeightDp: number;
}

const u16 = (c: Uint8Array, o: number): number => (o + 2 <= c.length ? c[o]! | (c[o + 1]! << 8) : 0);
const u8 = (c: Uint8Array, o: number): number => (o < c.length ? c[o]! : 0);
const chars = (c: Uint8Array, o: number): string => {
  const a = u8(c, o), b = u8(c, o + 1);
  return a ? String.fromCharCode(a) + (b ? String.fromCharCode(b) : '') : '';
};

export function parseConfig(c: Uint8Array): ArscConfigFields {
  return {
    mcc: u16(c, 4), mnc: u16(c, 6), language: chars(c, 8), country: chars(c, 10),
    orientation: u8(c, 12), touchscreen: u8(c, 13), density: u16(c, 14),
    keyboard: u8(c, 16), navigation: u8(c, 17), inputFlags: u8(c, 18),
    screenWidth: u16(c, 20), screenHeight: u16(c, 22),
    sdkVersion: u16(c, 24), minorVersion: u16(c, 26),
    screenLayout: u8(c, 28), uiMode: u8(c, 29), smallestScreenWidthDp: u16(c, 30),
    screenWidthDp: u16(c, 32), screenHeightDp: u16(c, 34),
  };
}

/** Builds a 28-byte config (the sub-set below is all this project needs). */
export function makeConfig(f: Partial<Pick<ArscConfigFields, 'density' | 'sdkVersion' | 'orientation' | 'mcc' | 'mnc'>> = {}): Uint8Array {
  const c = new Uint8Array(28);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, 28, true);
  dv.setUint16(4, f.mcc ?? 0, true);
  dv.setUint16(6, f.mnc ?? 0, true);
  c[12] = f.orientation ?? 0;
  dv.setUint16(14, f.density ?? 0, true);
  dv.setUint16(24, f.sdkVersion ?? 0, true);
  return c;
}

/** Equality ignoring trailing zero padding (configs of different declared sizes can describe the same qualifiers). */
export function configEquals(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.max(a.length, b.length);
  // the size field itself (first 4 bytes) is not a qualifier
  for (let i = 4; i < n; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return false;
  return true;
}

/** Which typeSpec change flags this config contributes (only the qualifiers this layer can build or recognise). */
export function configChangeFlags(c: Uint8Array): number {
  const f = parseConfig(c);
  let r = 0;
  if (f.mcc) r |= CONFIG_CHANGE.mcc;
  if (f.mnc) r |= CONFIG_CHANGE.mnc;
  if (f.language || f.country) r |= CONFIG_CHANGE.locale;
  if (f.orientation) r |= CONFIG_CHANGE.orientation;
  if (f.density) r |= CONFIG_CHANGE.density;
  if (f.sdkVersion) r |= CONFIG_CHANGE.version;
  return r;
}

const DENSITY_NAMES = new Map<number, string>(Object.entries(DENSITY).map(([k, v]) => [v, k]));

/** Resource-directory style qualifier string ("" for the default config), e.g. `anydpi-v26`, `en-rUS-hdpi-v4`. */
export function configToString(c: Uint8Array): string {
  const f = parseConfig(c);
  const parts: string[] = [];
  if (f.mcc) parts.push(`mcc${f.mcc}`);
  if (f.mnc) parts.push(`mnc${f.mnc}`);
  if (f.language) parts.push(f.country ? `${f.language}-r${f.country}` : f.language);
  if (f.orientation) parts.push(f.orientation === 1 ? 'port' : f.orientation === 2 ? 'land' : 'square');
  if (f.density) parts.push(DENSITY_NAMES.get(f.density) ?? `${f.density}dpi`);
  if (f.sdkVersion) parts.push(`v${f.sdkVersion}`);
  return parts.join('-');
}
