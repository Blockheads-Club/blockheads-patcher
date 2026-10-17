/** Independent verification of an APK Signature Scheme v2 block using node:crypto (no apksigner needed). */
import { createHash, createVerify, X509Certificate } from 'node:crypto';
import { locateEocd } from '../src/zip';

const CHUNK = 1024 * 1024;
const sha256 = (...p: Uint8Array[]): Buffer => { const h = createHash('sha256'); p.forEach((x) => h.update(x)); return h.digest(); };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  u32(): number { const v = Buffer.from(this.b.buffer, this.b.byteOffset + this.pos, 4).readUInt32LE(); this.pos += 4; return v; }
  lp(): Uint8Array { const n = this.u32(); const out = this.b.subarray(this.pos, this.pos + n); this.pos += n; return out; }
  get done(): boolean { return this.pos >= this.b.length; }
}

export interface V2Result { digestOk: boolean; signatureOk: boolean; certDer: Buffer; blockStart: number }

export function verifyV2(apk: Uint8Array): V2Result {
  const { eocdOffset, cdOffset, cdSize } = locateEocd(apk);
  const buf = Buffer.from(apk.buffer, apk.byteOffset, apk.byteLength);
  if (buf.toString('latin1', cdOffset - 16, cdOffset) !== 'APK Sig Block 42') throw new Error('no signing block');
  const size = Number(buf.readBigUInt64LE(cdOffset - 24));
  const blockStart = cdOffset - size - 8;
  if (Number(buf.readBigUInt64LE(blockStart)) !== size) throw new Error('block size fields differ');
  let p = blockStart + 8, value: Uint8Array | undefined;
  while (p < cdOffset - 24) {
    const len = Number(buf.readBigUInt64LE(p));
    if (buf.readUInt32LE(p + 8) === 0x7109871a) value = apk.subarray(p + 12, p + 8 + len);
    p += 8 + len;
  }
  if (!value) throw new Error('no v2 pair');
  const signers = new Reader(new Reader(value).lp());
  const signer = new Reader(signers.lp());
  const signedData = signer.lp();
  const sigs = new Reader(new Reader(signer.lp()).lp());
  const alg = sigs.u32();
  const signature = sigs.lp();
  const spki = signer.lp();
  if (alg !== 0x0103) throw new Error('unexpected algorithm');
  const sd = new Reader(signedData);
  const digestEntry = new Reader(new Reader(sd.lp()).lp());
  digestEntry.u32();
  const digest = Buffer.from(digestEntry.lp());
  const certDer = Buffer.from(new Reader(sd.lp()).lp());

  // recompute the content digest: contents, central directory, EOCD (cd offset = start of the block)
  const eocd = Buffer.from(buf.subarray(eocdOffset));
  eocd.writeUInt32LE(blockStart, 16);
  const chunks: Buffer[] = [];
  for (const sec of [buf.subarray(0, blockStart), buf.subarray(cdOffset, cdOffset + cdSize), eocd]) {
    for (let o = 0; o < sec.length; o += CHUNK) {
      const part = sec.subarray(o, Math.min(o + CHUNK, sec.length));
      chunks.push(sha256(Buffer.from([0xa5]), u32(part.length), part));
    }
  }
  const expected = sha256(Buffer.from([0x5a]), u32(chunks.length), ...chunks);
  const cert = new X509Certificate(certDer);
  const pubOk = Buffer.from(cert.publicKey.export({ type: 'spki', format: 'der' })).equals(Buffer.from(spki));
  const v = createVerify('sha256');
  v.update(signedData);
  return { digestOk: expected.equals(digest), signatureOk: pubOk && v.verify(cert.publicKey, signature), certDer, blockStart };
}
