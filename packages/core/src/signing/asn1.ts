// Minimal DER encoder (+ tiny decoder for imported certificates).

export class Asn1Error extends Error {}

function concat(...b: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const x of b) n += x.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of b) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

function lenBytes(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), lenBytes(content.length), content);
}

function intBytes(v: bigint | Uint8Array): Uint8Array {
  let b: Uint8Array;
  if (typeof v === 'bigint') {
    if (v < 0n) throw new Asn1Error('negative integers unsupported');
    let hex = v.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    b = v;
  }
  // strip redundant leading zeros, then add one if the high bit is set (unsigned semantics)
  let start = 0;
  while (start < b.length - 1 && b[start] === 0) start++;
  b = b.subarray(start);
  if (b.length === 0) return Uint8Array.of(0);
  return (b[0] as number) & 0x80 ? concat(Uint8Array.of(0), b) : b;
}

function oidBytes(dotted: string): Uint8Array {
  const parts = dotted.split('.').map((p) => BigInt(p));
  if (parts.length < 2) throw new Asn1Error('bad OID');
  const out: number[] = [];
  const enc = (v: bigint) => {
    const tmp: number[] = [Number(v & 0x7fn)];
    v >>= 7n;
    while (v > 0n) {
      tmp.unshift(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(...tmp);
  };
  enc((parts[0] as bigint) * 40n + (parts[1] as bigint));
  for (const p of parts.slice(2)) enc(p);
  return Uint8Array.from(out);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export const der = {
  seq: (...c: Uint8Array[]) => tlv(0x30, concat(...c)),
  set: (...c: Uint8Array[]) => tlv(0x31, concat(...c)),
  int: (v: bigint | Uint8Array) => tlv(0x02, intBytes(v)),
  oid: (dotted: string) => tlv(0x06, oidBytes(dotted)),
  octets: (b: Uint8Array) => tlv(0x04, b),
  utf8: (s: string) => tlv(0x0c, new TextEncoder().encode(s)),
  printable: (s: string) => tlv(0x13, new TextEncoder().encode(s)),
  /** UTCTime for years 1950-2049, GeneralizedTime otherwise (RFC 5280). */
  utcTime(d: Date): Uint8Array {
    const y = d.getUTCFullYear();
    const rest = `${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
    if (y >= 1950 && y < 2050) return tlv(0x17, new TextEncoder().encode(pad2(y % 100) + rest));
    return tlv(0x18, new TextEncoder().encode(String(y).padStart(4, '0') + rest));
  },
  bitString: (b: Uint8Array) => tlv(0x03, concat(Uint8Array.of(0), b)),
  nul: () => Uint8Array.of(0x05, 0x00),
  ctx: (tag: number, c: Uint8Array, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | tag, c),
  bool: (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0x00)),
  concat,
};

// ---------------------------------------------------------------- decoder

export interface Asn1Node {
  tag: number;
  /** Full encoding (header + content). */
  raw: Uint8Array;
  content: Uint8Array;
  children(): Asn1Node[];
}

export function parseDer(bytes: Uint8Array, offset = 0): Asn1Node {
  const { node, end } = parseAt(bytes, offset);
  if (end !== bytes.length && offset === 0) {
    // allow trailing data only if caller used offset; strict for whole-buffer parse
    throw new Asn1Error('trailing data after DER element');
  }
  return node;
}

function parseAt(bytes: Uint8Array, offset: number): { node: Asn1Node; end: number } {
  if (offset + 2 > bytes.length) throw new Asn1Error('truncated DER');
  const tag = bytes[offset] as number;
  let p = offset + 1;
  let len = bytes[p++] as number;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > bytes.length) throw new Asn1Error('bad DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (bytes[p++] as number);
  }
  const end = p + len;
  if (end > bytes.length) throw new Asn1Error('DER element exceeds buffer');
  const content = bytes.subarray(p, end);
  const raw = bytes.subarray(offset, end);
  const constructed = (tag & 0x20) !== 0;
  return {
    end,
    node: {
      tag,
      raw,
      content,
      children() {
        if (!constructed) throw new Asn1Error('primitive element has no children');
        const out: Asn1Node[] = [];
        let q = 0;
        while (q < content.length) {
          const r = parseAt(content, q);
          out.push(r.node);
          q = r.end;
        }
        return out;
      },
    },
  };
}
