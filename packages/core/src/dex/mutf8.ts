import { DexError } from './bytes';

/** Decodes modified UTF-8 (as stored in DEX string_data) into a JS string of UTF-16 code units. */
export function decodeMutf8(b: Uint8Array): string {
  const out: number[] = [];
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++]!;
    if (c < 0x80) out.push(c);
    else if ((c & 0xe0) === 0xc0 && i < b.length) out.push(((c & 0x1f) << 6) | (b[i++]! & 0x3f));
    else if ((c & 0xf0) === 0xe0 && i + 1 < b.length) { out.push(((c & 0x0f) << 12) | ((b[i]! & 0x3f) << 6) | (b[i + 1]! & 0x3f)); i += 2; }
    else throw new DexError('invalid modified UTF-8');
    if (out.length >= 4096) { s += String.fromCharCode(...out); out.length = 0; }
  }
  return s + String.fromCharCode(...out);
}

/** Encodes a JS string as modified UTF-8 (NUL as C0 80, surrogates as separate 3-byte sequences). */
export function encodeMutf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** Number of UTF-16 code units of a modified UTF-8 string (the value stored in string_data_item's uleb128 prefix). */
export function utf16Length(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    i += c < 0x80 ? 1 : (c & 0xe0) === 0xc0 ? 2 : 3;
    n++;
  }
  return n;
}
