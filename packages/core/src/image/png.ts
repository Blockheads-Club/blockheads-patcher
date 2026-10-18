/** Minimal pure-TS PNG codec (8-bit output) and image resampling, used to derive the adaptive-icon artwork. */
import { unzlibSync, zlibSync } from 'fflate';
import { crc32 } from '../zip/crc32';

export class PngError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PngError';
  }
}

/** Straight (non-premultiplied) RGBA, 4 bytes per pixel. */
export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Samples per pixel by colour type: gray, -, rgb, palette, gray+alpha, -, rgba. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undoes filter type `t` in place on `row` (`prev` is the previous, already reconstructed row). */
function unfilter(t: number, row: Uint8Array, prev: Uint8Array, bpp: number): void {
  if (t === 0) return;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
    const add = t === 1 ? a : t === 2 ? b : t === 3 ? (a + b) >> 1 : paeth(a, b, c);
    row[i] = (row[i]! + add) & 0xff;
  }
}
function filterRow(t: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
    const sub = t === 0 ? 0 : t === 1 ? a : t === 2 ? b : t === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out[i] = (row[i]! - sub) & 0xff;
  }
  return out;
}

export function decodePng(bytes: Uint8Array): Image {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) throw new PngError('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let p = 8;
  let ended = false;
  while (p + 12 <= bytes.length) {
    const len = dv.getUint32(p, false);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    if (p + 12 + len > bytes.length) throw new PngError('truncated PNG');
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      if (len < 13) throw new PngError('bad IHDR');
      width = dv.getUint32(p + 8, false);
      height = dv.getUint32(p + 12, false);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
    p += 12 + len;
  }
  if (!ended) throw new PngError('truncated PNG');
  const channels = CHANNELS[colorType];
  if (!channels || width === 0 || height === 0) throw new PngError('missing or unsupported IHDR');
  if (interlace) throw new PngError('interlaced PNGs are not supported');
  const okDepth = colorType === 3 ? [1, 2, 4, 8].includes(depth) : colorType === 0 ? depth === 8 || depth === 16 : depth === 8 || depth === 16;
  if (!okDepth) throw new PngError(`unsupported bit depth ${depth}`);
  if (colorType === 3 && !palette) throw new PngError('palette PNG without PLTE');
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let w = 0;
  for (const c of idat) { joined.set(c, w); w += c.length; }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(joined);
  } catch {
    throw new PngError('corrupt image data');
  }
  if (raw.length < (stride + 1) * height) throw new PngError('image data too short');
  const rgba = new Uint8Array(width * height * 4);
  let prev: Uint8Array = new Uint8Array(stride);
  const step = depth === 16 ? 2 : 1;
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]!;
    if (ft > 4) throw new PngError(`bad filter type ${ft}`);
    const row = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    unfilter(ft, row, prev, bpp);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const bit = x * depth;
        const idx = (row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        rgba[o] = palette![idx * 3] ?? 0;
        rgba[o + 1] = palette![idx * 3 + 1] ?? 0;
        rgba[o + 2] = palette![idx * 3 + 2] ?? 0;
        rgba[o + 3] = trns?.[idx] ?? 255;
      } else {
        const s = (c: number): number => row[(x * channels + c) * step]!;
        if (colorType === 0 || colorType === 4) {
          rgba[o] = rgba[o + 1] = rgba[o + 2] = s(0);
          rgba[o + 3] = colorType === 4 ? s(1) : 255;
        } else {
          rgba[o] = s(0); rgba[o + 1] = s(1); rgba[o + 2] = s(2);
          rgba[o + 3] = colorType === 6 ? s(3) : 255;
        }
      }
    }
    prev = row;
  }
  return { width, height, rgba };
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

/** Encodes 8-bit RGB (when fully opaque) or RGBA, choosing a scanline filter per row. */
export function encodePng(img: Image): Uint8Array {
  const { width, height, rgba } = img;
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4;
  const stride = width * ch;
  const raw = new Uint8Array((stride + 1) * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x++) for (let c = 0; c < ch; c++) row[x * ch + c] = rgba[(y * width + x) * 4 + c]!;
    let best = 0, bestScore = Infinity, bestRow: Uint8Array = row;
    for (let t = 0; t < 5; t++) {
      const f = filterRow(t, row, prev, ch);
      let score = 0;
      for (const v of f) score += v < 128 ? v : 256 - v;
      if (score < bestScore) { best = t; bestScore = score; bestRow = f; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(bestRow, y * (stride + 1) + 1);
    prev = row;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const parts = [Uint8Array.from(SIGNATURE), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibSync(raw, { level: 9 })), pngChunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let w = 0;
  for (const x of parts) { out.set(x, w); w += x.length; }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Resampling

/** Per destination pixel: first source index and normalised tent-filter weights (support widens when shrinking). */
function axisWeights(src: number, dst: number): { start: number; w: Float32Array }[] {
  const scale = src / dst;
  const support = Math.max(1, scale);
  const out: { start: number; w: Float32Array }[] = [];
  for (let x = 0; x < dst; x++) {
    const center = (x + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.ceil(center - support)), hi = Math.min(src - 1, Math.floor(center + support));
    const w = new Float32Array(hi - lo + 1);
    let sum = 0; // always > 0: some source pixel lies within half a pixel of the centre
    for (let i = lo; i <= hi; i++) { w[i - lo] = Math.max(0, 1 - Math.abs(i - center) / support); sum += w[i - lo]!; }
    for (let i = 0; i < w.length; i++) w[i] = w[i]! / sum;
    out.push({ start: lo, w });
  }
  return out;
}

/** Resizes with a tent filter on premultiplied alpha (so transparent pixels do not bleed their colour). */
export function resizeImage(img: Image, width: number, height: number): Image {
  const { width: sw, height: sh, rgba } = img;
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) pre[i * 4 + c] = rgba[i * 4 + c]! * a;
    pre[i * 4 + 3] = rgba[i * 4 + 3]!;
  }
  const wx = axisWeights(sw, width), wy = axisWeights(sh, height);
  const tmp = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < width; x++) {
      const { start, w } = wx[x]!;
      for (let c = 0; c < 4; c++) {
        let v = 0;
        for (let i = 0; i < w.length; i++) v += pre[(y * sw + start + i) * 4 + c]! * w[i]!;
        tmp[(y * width + x) * 4 + c] = v;
      }
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const { start, w } = wy[y]!;
    for (let x = 0; x < width; x++) {
      const v = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) for (let i = 0; i < w.length; i++) v[c]! += tmp[((start + i) * width + x) * 4 + c]! * w[i]!;
      const a = v[3]!;
      for (let c = 0; c < 3; c++) out[(y * width + x) * 4 + c] = a > 0 ? Math.min(255, Math.round((v[c]! * 255) / a)) : 0;
      out[(y * width + x) * 4 + 3] = Math.round(a);
    }
  }
  return { width, height, rgba: out };
}

export interface AdaptiveArtwork {
  /** Square foreground layer (108dp canvas) with the icon centred inside the safe zone. */
  foreground: Image;
  /** Opaque colour (0xRRGGBB) sampled from the icon border, for the background layer. */
  background: number;
}

/**
 * Builds the layers of an adaptive icon from a legacy square icon: the artwork is scaled to the 66dp safe zone of the
 * 108dp canvas. A fully opaque icon gets its edge pixels extended over the padding (so no seam shows against the
 * background); an icon with transparency is padded with transparent pixels.
 */
export function makeAdaptiveArtwork(icon: Image, canvas = 432): AdaptiveArtwork {
  const inner = Math.round((canvas * 66) / 108);
  const scaled = resizeImage(icon, inner, inner);
  const off = Math.floor((canvas - inner) / 2);
  const rgba = new Uint8Array(canvas * canvas * 4);
  let opaque = true;
  for (let i = 3; i < scaled.rgba.length; i += 4) if (scaled.rgba[i] !== 255) { opaque = false; break; }
  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      const sx = x - off, sy = y - off;
      const inside = sx >= 0 && sy >= 0 && sx < inner && sy < inner;
      if (!inside && !opaque) continue;
      const cx = Math.min(inner - 1, Math.max(0, sx)), cy = Math.min(inner - 1, Math.max(0, sy));
      for (let c = 0; c < 4; c++) rgba[(y * canvas + x) * 4 + c] = scaled.rgba[(cy * inner + cx) * 4 + c]!;
    }
  }
  return { foreground: { width: canvas, height: canvas, rgba }, background: sampleBorderColor(icon) };
}

/** Alpha-weighted mean colour of the outer 4% ring of the image (white when it is fully transparent). */
export function sampleBorderColor(img: Image): number {
  const ring = Math.max(1, Math.round(Math.min(img.width, img.height) * 0.04));
  let r = 0, g = 0, b = 0, a = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (x >= ring && y >= ring && x < img.width - ring && y < img.height - ring) continue;
      const i = (y * img.width + x) * 4;
      const al = img.rgba[i + 3]!;
      r += img.rgba[i]! * al; g += img.rgba[i + 1]! * al; b += img.rgba[i + 2]! * al; a += al;
    }
  }
  if (a === 0) return 0xffffff;
  return (Math.round(r / a) << 16) | (Math.round(g / a) << 8) | Math.round(b / a);
}
