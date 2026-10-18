/** Test-side PNG writer for arbitrary colour types / bit depths / filters (independent of src/image). */
import { zlibSync } from 'fflate';
import { crc32 } from '../src';

const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
export function pngChunk(type: string, data: number[] | Uint8Array): number[] {
  const body = [...type].map((c) => c.charCodeAt(0)).concat(Array.from(data));
  return [...be32(data.length), ...body, ...be32(crc32(Uint8Array.from(body)))];
}

export interface RawPng {
  width: number;
  height: number;
  colorType: number;
  depth: number;
  /** Unfiltered scanline bytes per row. */
  rows: number[][];
  /** Filter type per row (default 0). */
  filters?: number[];
  palette?: number[];
  trns?: number[];
  interlace?: number;
  bpp?: number;
  idatSplit?: boolean;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function rawPng(o: RawPng): Uint8Array {
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[o.colorType] ?? 1;
  const bpp = o.bpp ?? Math.max(1, (ch * o.depth) >> 3);
  const raw: number[] = [];
  o.rows.forEach((row, y) => {
    const t = o.filters?.[y] ?? 0;
    const prev = o.rows[y - 1] ?? row.map(() => 0);
    raw.push(t);
    row.forEach((v, i) => {
      const a = i >= bpp ? row[i - bpp]! : 0, b = y > 0 ? prev[i]! : 0, c = i >= bpp && y > 0 ? prev[i - bpp]! : 0;
      const pred = t === 0 ? 0 : t === 1 ? a : t === 2 ? b : t === 3 ? (a + b) >> 1 : t === 4 ? paeth(a, b, c) : 0;
      raw.push((v - pred) & 0xff);
    });
  });
  const z = Array.from(zlibSync(Uint8Array.from(raw)));
  const idat = o.idatSplit ? [...pngChunk('IDAT', z.slice(0, 5)), ...pngChunk('IDAT', z.slice(5))] : pngChunk('IDAT', z);
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...be32(o.width), ...be32(o.height), o.depth, o.colorType, 0, 0, o.interlace ?? 0]),
    ...(o.palette ? pngChunk('PLTE', o.palette) : []),
    ...(o.trns ? pngChunk('tRNS', o.trns) : []),
    ...idat, ...pngChunk('IEND', []),
  ]);
}
