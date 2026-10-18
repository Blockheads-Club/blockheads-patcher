import {
  ANDROID_NS, ValueType, addAttr, buildAxml, getAttr, setAttrValue,
} from '../axml';
import {
  DENSITY, ResValue, addConfig, addResource, getResource, makeConfig, parseArsc, parseConfig, serializeArsc, type ArscTable,
} from '../arsc';
import { decodePng, encodePng, makeAdaptiveArtwork } from '../image';
import { getEntry, setEntry } from '../zip';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, findApplication } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

const ICON_ATTR_ID = 0x01010002;
const ROUND_ICON_ATTR_ID = 0x0101052c;
const DRAWABLE_ATTR_ID = 0x01010199;
const ARSC = 'resources.arsc';
export const ADAPTIVE_API = 26;

const XML_PATH = 'res/drawable-anydpi-v26/icon.xml';
const FOREGROUND_PATH = 'res/mipmap-nodpi/ic_launcher_foreground.png';

interface IconTarget {
  table: ArscTable;
  iconId: number;
}

/** The application's icon reference together with the parsed resource table, or undefined when either is unusable. */
function locate(ctx: PatchContext): IconTarget | undefined {
  const app = findApplication(ctx);
  const attr = app && getAttr(app, 'icon', ANDROID_NS, ICON_ATTR_ID);
  const arsc = getEntry(ctx.zip, ARSC);
  if (!attr || attr.valueType !== ValueType.Reference || !arsc) return undefined;
  try {
    const table = parseArsc(arsc.data);
    return getResource(table, attr.data) ? { table, iconId: attr.data } : undefined;
  } catch {
    return undefined; // not a resource table we can read
  }
}

const isAdaptiveConfig = (config: Uint8Array): boolean => {
  const f = parseConfig(config);
  return f.density === DENSITY.anydpi && f.sdkVersion >= ADAPTIVE_API;
};

function detect(ctx: PatchContext): PatchStatus {
  const t = locate(ctx);
  if (!t) return 'incompatible';
  const info = getResource(t.table, t.iconId)!;
  if (info.configs.some((c) => isAdaptiveConfig(c.config))) return 'applied';
  return info.configs.some((c) => c.entry.kind === 'value' && c.entry.string?.endsWith('.png')) ? 'notApplied' : 'incompatible';
}

/** The PNG of the most detailed density the icon resource provides (default config counts as mdpi). */
function pickSourcePng(info: NonNullable<ReturnType<typeof getResource>>): string {
  let best = '', bestDensity = -1;
  for (const c of info.configs) {
    if (c.entry.kind !== 'value' || !c.entry.string?.endsWith('.png')) continue;
    const d = parseConfig(c.config).density || DENSITY.mdpi;
    // anydpi / nodpi sort above every real density, so they would always win; treat them as lowest priority
    const rank = d >= DENSITY.anydpi ? 1 : d;
    if (rank > bestDensity) { best = c.entry.string; bestDensity = rank; }
  }
  return best;
}

const fail = (message: string): never => { throw new PatchError(message, 'cannotApply', { message }); };

/**
 * Adds an Android 8+ adaptive launcher icon built from the game's own icon artwork. The legacy PNGs stay untouched as
 * the fallback for older devices: the icon resource simply gains an `anydpi-v26` configuration (an adaptive-icon XML),
 * which only API 26+ devices select. Foreground = the largest icon PNG scaled into the 66dp safe zone of the 108dp
 * canvas, background = a solid colour sampled from the icon border. `roundIcon` points at a second resource that has the
 * same adaptive configuration and the plain icon as default, so API 25 round launchers keep working.
 */
export const adaptiveIcon: Patch = {
  id: 'adaptive-icon',
  version: 1,
  nameKey: 'patch.adaptive-icon.name',
  descriptionKey: 'patch.adaptive-icon.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE, versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  credits: JARLPENGUIN_CREDITS,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`adaptive-icon cannot be applied (status: ${status})`, 'cannotApply', { status });
    const { table, iconId } = locate(ctx)!;
    const sourcePath = pickSourcePng(getResource(table, iconId)!);
    const source = getEntry(ctx.zip, sourcePath);
    if (!source) return fail(`icon file ${sourcePath} is missing from the APK`);
    let art;
    try {
      art = makeAdaptiveArtwork(decodePng(source.data));
    } catch (e) {
      return fail(`cannot read the icon: ${(e as Error).message}`);
    }
    const noDpi = makeConfig({ density: DENSITY.nodpi });
    const anyDpi26 = makeConfig({ density: DENSITY.anydpi, sdkVersion: ADAPTIVE_API });
    let fgId: number, bgId: number, roundId: number;
    try {
      fgId = addResource(table, { type: 'mipmap', name: 'ic_launcher_foreground', configs: [{ config: noDpi, value: { kind: 'string', value: FOREGROUND_PATH } }] });
      bgId = addResource(table, {
        type: 'color', name: 'ic_launcher_background',
        configs: [{ config: makeConfig(), value: { kind: 'value', dataType: ResValue.ColorArgb8, data: (0xff000000 | art.background) >>> 0 } }],
      });
      addConfig(table, iconId, anyDpi26, { kind: 'string', value: XML_PATH });
      roundId = addResource(table, {
        type: 'mipmap', name: 'ic_launcher_round',
        configs: [
          { config: makeConfig(), value: { kind: 'value', dataType: ResValue.Reference, data: iconId } },
          { config: anyDpi26, value: { kind: 'string', value: XML_PATH } },
        ],
      });
    } catch (e) {
      return fail(`cannot extend the resource table: ${(e as Error).message}`);
    }
    const ref = (data: number) => ({ type: ValueType.Reference, data });
    const xml = buildAxml({
      name: 'adaptive-icon',
      children: [
        { name: 'background', attrs: [{ name: 'drawable', resourceId: DRAWABLE_ATTR_ID, value: ref(bgId) }] },
        { name: 'foreground', attrs: [{ name: 'drawable', resourceId: DRAWABLE_ATTR_ID, value: ref(fgId) }] },
      ],
    });
    setEntry(ctx.zip, { name: XML_PATH, data: xml });
    setEntry(ctx.zip, { name: FOREGROUND_PATH, data: encodePng(art.foreground), method: 0 });
    setEntry(ctx.zip, { name: ARSC, data: serializeArsc(table) });
    const app = findApplication(ctx)!;
    const existing = getAttr(app, 'roundIcon', ANDROID_NS, ROUND_ICON_ATTR_ID);
    if (existing) setAttrValue(ctx.manifest, existing, ValueType.Reference, roundId);
    else {
      addAttr(ctx.manifest, app, {
        nsUri: ANDROID_NS, name: 'roundIcon', resourceId: ROUND_ICON_ATTR_ID, rawValue: null, valueType: ValueType.Reference, data: roundId,
      });
    }
    ctx.markManifestDirty();
    ctx.log(`adaptive icon added (background #${art.background.toString(16).padStart(6, '0')}, ids fg 0x${fgId.toString(16)} bg 0x${bgId.toString(16)} round 0x${roundId.toString(16)})`);
  },
};
