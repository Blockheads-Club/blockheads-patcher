import { describe, it, expect } from 'vitest';
import { decodePng, encodePng, resizeImage, makeAdaptiveArtwork, sampleBorderColor, PngError, type Image } from '../src';
import { rawPng, pngChunk } from './png-builder';

const solid = (w: number, h: number, c: [number, number, number, number]): Image => ({
  width: w, height: h, rgba: Uint8Array.from({ length: w * h * 4 }, (_, i) => c[i % 4]!),
});
const px = (img: Image, x: number, y: number): number[] => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const gradient = (w: number, h: number, alpha = 255): Image => ({
  width: w, height: h,
  rgba: Uint8Array.from({ length: w * h * 4 }, (_, i) => { const p = i >> 2, c = i & 3; return c === 3 ? alpha : c === 0 ? (p % w) * 7 : c === 1 ? Math.floor(p / w) * 11 : (p * 3) & 255; }),
});

describe('PNG codec', () => {
  it('round-trips opaque (RGB) and translucent (RGBA) images', () => {
    for (const img of [gradient(17, 9), gradient(5, 5, 128), solid(3, 2, [1, 2, 3, 255])]) {
      const back = decodePng(encodePng(img));
      expect([back.width, back.height]).toEqual([img.width, img.height]);
      expect(Buffer.from(back.rgba).equals(Buffer.from(img.rgba))).toBe(true);
    }
    expect(encodePng(solid(2, 2, [0, 0, 0, 255]))[25]).toBe(2);
    expect(encodePng(solid(2, 2, [0, 0, 0, 0]))[25]).toBe(6);
  });
  it('decodes every scanline filter', () => {
    const rows = [[10, 20, 30, 40, 50, 60], [15, 25, 35, 45, 55, 65], [1, 2, 3, 4, 5, 6], [200, 100, 50, 25, 12, 6], [9, 8, 7, 6, 5, 4]];
    const png = decodePng(rawPng({ width: 2, height: 5, colorType: 2, depth: 8, rows, filters: [0, 1, 2, 3, 4] }));
    expect(Array.from(png.rgba.subarray(0, 8))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(Array.from(png.rgba.subarray(8 * 3, 8 * 3 + 4))).toEqual([200, 100, 50, 255]);
    expect(Array.from(png.rgba.subarray(8 * 4 + 4))).toEqual([6, 5, 4, 255]);
  });
  it('picks filters on encode that decode back (smooth + noisy rows)', () => {
    const img = gradient(32, 32);
    img.rgba.forEach((_, i) => { if (i % 97 === 0) img.rgba[i] = (i * 31) & 255; });
    expect(Buffer.from(decodePng(encodePng(img)).rgba).equals(Buffer.from(img.rgba))).toBe(true);
  });
  it('decodes grey, grey+alpha, rgb, rgba at 8 and 16 bits and split IDAT chunks', () => {
    expect(Array.from(decodePng(rawPng({ width: 1, height: 1, colorType: 0, depth: 8, rows: [[77]] })).rgba)).toEqual([77, 77, 77, 255]);
    expect(Array.from(decodePng(rawPng({ width: 1, height: 1, colorType: 0, depth: 16, rows: [[77, 1]] })).rgba)).toEqual([77, 77, 77, 255]);
    expect(Array.from(decodePng(rawPng({ width: 1, height: 1, colorType: 4, depth: 8, rows: [[77, 50]] })).rgba)).toEqual([77, 77, 77, 50]);
    expect(Array.from(decodePng(rawPng({ width: 1, height: 1, colorType: 2, depth: 16, rows: [[1, 9, 2, 9, 3, 9]], idatSplit: true })).rgba)).toEqual([1, 2, 3, 255]);
    expect(Array.from(decodePng(rawPng({ width: 1, height: 1, colorType: 6, depth: 16, rows: [[1, 9, 2, 9, 3, 9, 4, 9]] })).rgba)).toEqual([1, 2, 3, 4]);
  });
  it('decodes palette images at every depth, with and without tRNS', () => {
    const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9];
    // 1 bit: pixels 1,0,1,1 -> 0b1011_0000
    expect(Array.from(decodePng(rawPng({ width: 4, height: 1, colorType: 3, depth: 1, rows: [[0b10110000]], palette: [0, 0, 0, 255, 255, 255] })).rgba.filter((_, i) => i % 4 === 0)))
      .toEqual([255, 0, 255, 255]);
    // 2 bits: 0,1,2,3
    expect(Array.from(decodePng(rawPng({ width: 4, height: 1, colorType: 3, depth: 2, rows: [[0b00011011]], palette })).rgba.slice(0, 16)))
      .toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
    // 4 bits with transparency for the first entry only
    const four = decodePng(rawPng({ width: 2, height: 1, colorType: 3, depth: 4, rows: [[0x01]], palette, trns: [10] }));
    expect(Array.from(four.rgba)).toEqual([255, 0, 0, 10, 0, 255, 0, 255]);
    // 8 bits, index beyond the palette reads as black
    expect(Array.from(decodePng(rawPng({ width: 1, height: 1, colorType: 3, depth: 8, rows: [[5]], palette })).rgba)).toEqual([0, 0, 0, 255]);
  });
  it('rejects unsupported or damaged files', () => {
    const ok = rawPng({ width: 1, height: 1, colorType: 2, depth: 8, rows: [[1, 2, 3]] });
    expect(() => decodePng(new Uint8Array(4))).toThrow(PngError);
    expect(() => decodePng(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/);
    expect(() => decodePng(ok.subarray(0, ok.length - 20))).toThrow(/truncated/);
    expect(() => decodePng(ok.subarray(0, ok.length - 12))).toThrow(/truncated/);
    expect(() => decodePng(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IEND', [])]))).toThrow(/IHDR/);
    expect(() => decodePng(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', [0, 0, 0, 1]), ...pngChunk('IEND', [])]))).toThrow(/bad IHDR/);
    expect(() => decodePng(rawPng({ width: 1, height: 1, colorType: 1, depth: 8, rows: [[1]] }))).toThrow(/unsupported IHDR/);
    expect(() => decodePng(rawPng({ width: 1, height: 1, colorType: 2, depth: 8, rows: [[1, 2, 3]], interlace: 1 }))).toThrow(/interlaced/);
    expect(() => decodePng(rawPng({ width: 1, height: 1, colorType: 2, depth: 4, rows: [[1, 2, 3]] }))).toThrow(/bit depth 4/);
    expect(() => decodePng(rawPng({ width: 1, height: 1, colorType: 0, depth: 2, rows: [[1]] }))).toThrow(/bit depth 2/);
    expect(() => decodePng(rawPng({ width: 1, height: 1, colorType: 3, depth: 8, rows: [[1]] }))).toThrow(/PLTE/);
    const bad = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), ...pngChunk('IDAT', [1, 2, 3]), ...pngChunk('IEND', [])]);
    expect(() => decodePng(bad)).toThrow(/corrupt/);
    expect(() => decodePng(rawPng({ width: 4, height: 4, colorType: 2, depth: 8, rows: [[1, 2, 3]] }))).toThrow(/too short/);
    expect(() => decodePng(rawPng({ width: 1, height: 1, colorType: 2, depth: 8, rows: [[1, 2, 3]], filters: [9] }))).toThrow(/filter type 9/);
  });
});

describe('resizeImage', () => {
  it('keeps solid colours and image size semantics', () => {
    for (const [w, h] of [[8, 8], [3, 3], [20, 20], [8, 16]] as const) {
      const out = resizeImage(solid(8, 8, [10, 200, 30, 255]), w, h);
      expect([out.width, out.height]).toEqual([w, h]);
      expect(px(out, 0, 0)).toEqual([10, 200, 30, 255]);
      expect(px(out, w - 1, h - 1)).toEqual([10, 200, 30, 255]);
    }
  });
  it('averages when shrinking and interpolates when growing', () => {
    const checker: Image = { width: 2, height: 1, rgba: Uint8Array.from([0, 0, 0, 255, 200, 200, 200, 255]) };
    expect(px(resizeImage(checker, 1, 1), 0, 0)).toEqual([100, 100, 100, 255]);
    const up = resizeImage(checker, 4, 1);
    expect(px(up, 0, 0)[0]).toBeLessThan(px(up, 1, 0)[0]!);
    expect(px(up, 1, 0)[0]).toBeLessThan(px(up, 3, 0)[0]!);
  });
  it('does not bleed colour out of transparent pixels', () => {
    const img: Image = { width: 2, height: 1, rgba: Uint8Array.from([255, 0, 0, 0, 0, 0, 255, 255]) };
    const out = resizeImage(img, 1, 1);
    expect(px(out, 0, 0)).toEqual([0, 0, 255, 128]);
    expect(px(resizeImage(solid(2, 2, [9, 9, 9, 0]), 1, 1), 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('adaptive artwork', () => {
  it('scales into the safe zone and extends the edge of opaque icons over the padding', () => {
    const icon = gradient(64, 64);
    const art = makeAdaptiveArtwork(icon, 108);
    expect([art.foreground.width, art.foreground.height]).toEqual([108, 108]);
    // 66/108 of the canvas holds the artwork: offset 21, size 66
    expect(px(art.foreground, 0, 0)).toEqual(px(art.foreground, 21, 21));
    expect(px(art.foreground, 107, 107)).toEqual(px(art.foreground, 86, 86));
    expect(px(art.foreground, 54, 0)).toEqual(px(art.foreground, 54, 21));
    expect(px(art.foreground, 0, 54)).toEqual(px(art.foreground, 21, 54));
    expect(px(art.foreground, 54, 54)[3]).toBe(255);
  });
  it('pads icons that have transparency with transparent pixels', () => {
    const art = makeAdaptiveArtwork(solid(32, 32, [200, 100, 50, 128]), 108);
    expect(px(art.foreground, 0, 0)[3]).toBe(0);
    expect(px(art.foreground, 54, 54)).toEqual([200, 100, 50, 128]);
    expect(art.background).toBe(0xc86432);
  });
  it('defaults to a 432px canvas', () => {
    expect(makeAdaptiveArtwork(solid(4, 4, [0, 0, 0, 255])).foreground.width).toBe(432);
  });
  it('samples the border colour, alpha weighted, white when nothing is visible', () => {
    const img = solid(50, 50, [0, 0, 255, 255]);
    for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) img.rgba.set([255, 0, 0, 255], (y * 50 + x) * 4);
    expect(sampleBorderColor(img)).toBe(0x0000ff);
    expect(sampleBorderColor(solid(10, 10, [5, 5, 5, 0]))).toBe(0xffffff);
    expect(sampleBorderColor(solid(1, 1, [1, 2, 3, 255]))).toBe(0x010203);
  });
});
