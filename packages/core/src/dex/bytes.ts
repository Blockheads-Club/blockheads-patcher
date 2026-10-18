/** Error raised by the DEX layer (malformed input, unsupported feature, invalid edit). */
export class DexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DexError';
  }
}

/** Little-endian cursor over a byte array with LEB128 support. Reads past the end throw DexError. */
export class ByteReader {
  private readonly dv: DataView;
  constructor(readonly buf: Uint8Array, public pos = 0) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void {
    if (this.pos < 0 || this.pos + n > this.buf.length) throw new DexError(`read out of bounds at ${this.pos}`);
  }
  u8(): number { this.need(1); return this.buf[this.pos++]!; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  uleb(): number {
    let result = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
    }
    throw new DexError('uleb128 too long');
  }
  /** Unsigned LEB128 plus one (0 encodes NO_INDEX = -1). */
  ulebP1(): number { return this.uleb() - 1; }
  sleb(): number {
    let result = 0, shift = 0, b = 0;
    for (let i = 0; i < 5; i++) {
      b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) {
        return b & 0x40 ? result - 2 ** shift : result;
      }
    }
    throw new DexError('sleb128 too long');
  }
}

/** Growable little-endian byte sink. */
export class ByteWriter {
  buf = new Uint8Array(1024);
  len = 0;
  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v: number): void { this.grow(1); this.buf[this.len++] = v & 0xff; }
  u16(v: number): void { this.u8(v); this.u8(v >>> 8); }
  u32(v: number): void { this.u16(v); this.u16(v >>> 16); }
  bytes(b: Uint8Array): void { this.grow(b.length); this.buf.set(b, this.len); this.len += b.length; }
  uleb(v: number): void {
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      this.u8(b);
    } while (v > 0);
  }
  ulebP1(v: number): void { this.uleb(v + 1); }
  sleb(v: number): void {
    for (;;) {
      const b = ((v % 128) + 128) % 128;
      v = Math.floor(v / 128);
      const done = (v === 0 && !(b & 0x40)) || (v === -1 && !!(b & 0x40));
      this.u8(done ? b : b | 0x80);
      if (done) return;
    }
  }
  align(n: number): void { while (this.len % n) this.u8(0); }
  set32(at: number, v: number): void { new DataView(this.buf.buffer).setUint32(at, v >>> 0, true); }
  result(): Uint8Array { return this.buf.slice(0, this.len); }
}
