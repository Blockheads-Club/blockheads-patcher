import { der } from './asn1';
import { SigningError } from './errors';
import { parseCertificate, toBase64, type SigningIdentity } from './identity';
import { throwIfCancelled } from '../abort';
import { locateEocd, peekData, getEntry, readZip, removeSignatureFiles, setEntry, writeZip, type ZipArchive } from '../zip';
import { manifestInfo, parseAxml } from '../axml';

export interface SignOptions {
  identity: SigningIdentity;
  createdBy?: string;
  minSdk?: number;
  /** Cancels signing between entries (throws CancelledError). */
  signal?: AbortSignal;
  /** Fraction 0..1 of the whole signing job. */
  onProgress?: (fraction: number) => void;
}

const SIG_BASE = 'META-INF/BHPATCH';
const buf = (u: Uint8Array) => u as unknown as BufferSource;
const enc = new TextEncoder();

/** JAR signatures with SHA-256 are only honoured by Android >= 4.3 (API 18); older minSdk needs SHA-1 (like apksigner). */
const useSha1 = (opts: SignOptions) => opts.minSdk !== undefined && opts.minSdk < 18;

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', buf(data)));
}
async function rsaSignSha1(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', key);
  const k = await globalThis.crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, buf(data)));
}

/**
 * Read android:minSdkVersion from the APK's binary manifest. A manifest that parses but declares no
 * integer minSdkVersion counts as 1 (Android's default), which selects the conservative SHA-1 JAR digests.
 * Returns undefined only if the manifest is missing or unparseable.
 */
export function detectMinSdk(zip: ZipArchive): number | undefined {
  try {
    const e = getEntry(zip, 'AndroidManifest.xml');
    if (!e) return undefined;
    return manifestInfo(parseAxml(e.data)).minSdk ?? 1;
  } catch {
    return undefined;
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf(data)));
}
async function rsaSign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, buf(data)));
}
function cat(...b: Uint8Array[]): Uint8Array {
  return der.concat(...b);
}

// ------------------------------------------------------------------ v1 (JAR)

/** Encode one manifest line (`Key: value`), wrapped at 72 bytes with CRLF + space continuation. */
function wrapLine(line: string): Uint8Array {
  const bytes = enc.encode(line);
  const out: number[] = [];
  let pos = 0;
  let max = 72;
  while (bytes.length - pos > max) {
    let end = pos + max;
    while (end > pos && ((bytes[end] as number) & 0xc0) === 0x80) end--; // don't split UTF-8 sequences
    out.push(...bytes.subarray(pos, end), 0x0d, 0x0a, 0x20);
    pos = end;
    max = 71;
  }
  out.push(...bytes.subarray(pos), 0x0d, 0x0a);
  return Uint8Array.from(out);
}

function isSignatureFile(name: string): boolean {
  if (!name.startsWith('META-INF/')) return false;
  if (name === 'META-INF/MANIFEST.MF') return true;
  const rest = name.slice(9);
  return !rest.includes('/') && (/\.(SF|RSA|DSA|EC)$/i.test(rest) || rest.startsWith('SIG-'));
}

function pkcs7Detached(identity: SigningIdentity, signature: Uint8Array, sha1Digest: boolean): Uint8Array {
  const { issuer, serial } = parseCertificate(identity.certificateDer);
  const sha256Alg = der.seq(der.oid(sha1Digest ? '1.3.14.3.2.26' : '2.16.840.1.101.3.4.2.1'), der.nul());
  const signerInfo = der.seq(
    der.int(1n),
    der.seq(issuer, serial),
    sha256Alg,
    der.seq(der.oid('1.2.840.113549.1.1.1'), der.nul()), // rsaEncryption
    der.octets(signature),
  );
  const signedData = der.seq(
    der.int(1n),
    der.set(sha256Alg),
    der.seq(der.oid('1.2.840.113549.1.7.1')), // detached: data with no content
    der.ctx(0, identity.certificateDer),
    der.set(signerInfo),
  );
  return der.seq(der.oid('1.2.840.113549.1.7.2'), der.ctx(0, signedData));
}

export async function v1Files(
  zip: ZipArchive,
  opts: SignOptions,
): Promise<{ manifest: Uint8Array; sf: Uint8Array; rsa: Uint8Array }> {
  const createdBy = opts.createdBy ?? 'Blockheads Patcher';
  const legacy = useSha1(opts);
  const hash = legacy ? sha1 : sha256;
  const label = legacy ? 'SHA1' : 'SHA-256';
  const header = (lines: string[]) => cat(...lines.map(wrapLine), enc.encode('\r\n'));

  const mainManifest = header(['Manifest-Version: 1.0', `Created-By: ${createdBy}`]);
  const sections: { name: string; bytes: Uint8Array }[] = [];
  let done = 0;
  for (const e of zip.entries) {
    throwIfCancelled(opts.signal);
    opts.onProgress?.(0.9 * (done++ / zip.entries.length));
    if (e.name.endsWith('/') || isSignatureFile(e.name)) continue;
    const digest = toBase64(await hash(peekData(e)));
    sections.push({ name: e.name, bytes: header([`Name: ${e.name}`, `${label}-Digest: ${digest}`]) });
  }
  const manifest = cat(mainManifest, ...sections.map((s) => s.bytes));

  const sfMain = header([
    'Signature-Version: 1.0',
    `Created-By: ${createdBy}`,
    `${label}-Digest-Manifest: ${toBase64(await hash(manifest))}`,
    'X-Android-APK-Signed: 2',
  ]);
  const sfSections: Uint8Array[] = [];
  for (const s of sections) {
    sfSections.push(header([`Name: ${s.name}`, `${label}-Digest: ${toBase64(await hash(s.bytes))}`]));
  }
  const sf = cat(sfMain, ...sfSections);
  const sig = legacy ? await rsaSignSha1(opts.identity.privateKey, sf) : await rsaSign(opts.identity.privateKey, sf);
  const rsa = pkcs7Detached(opts.identity, sig, legacy);
  return { manifest, sf, rsa };
}

// ------------------------------------------------------------------ v2 block

const V2_BLOCK_ID = 0x7109871a;
const ALG_RSA_PKCS1_SHA256 = 0x0103;
const CHUNK = 1024 * 1024;

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}
function u64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, v % 0x100000000, true);
  dv.setUint32(4, Math.floor(v / 0x100000000), true);
  return b;
}
/** uint32 length prefix. */
const lp = (b: Uint8Array) => cat(u32(b.length), b);

async function contentDigest(sections: Uint8Array[], opts: SignOptions): Promise<Uint8Array> {
  const chunkDigests: Uint8Array[] = [];
  for (const sec of sections) {
    for (let off = 0; off < sec.length; off += CHUNK) {
      const part = sec.subarray(off, Math.min(off + CHUNK, sec.length));
      throwIfCancelled(opts.signal);
      chunkDigests.push(await sha256(cat(Uint8Array.of(0xa5), u32(part.length), part)));
    }
  }
  return sha256(cat(Uint8Array.of(0x5a), u32(chunkDigests.length), ...chunkDigests));
}

export async function buildV2Block(zipWithoutBlock: Uint8Array, opts: SignOptions): Promise<Uint8Array> {
  const apk = zipWithoutBlock;
  const { eocdOffset, cdOffset, cdSize } = locateEocd(apk);
  // Reject an input that already holds a signing block directly before the CD.
  if (cdOffset >= 24) {
    const magic = new TextDecoder().decode(apk.subarray(cdOffset - 16, cdOffset));
    if (magic === 'APK Sig Block 42') throw new SigningError('input already contains an APK Signing Block');
  }
  const contents = apk.subarray(0, cdOffset);
  const cd = apk.subarray(cdOffset, cdOffset + cdSize);
  const eocd = apk.slice(eocdOffset); // copy: field is rewritten only for the new file; digest uses original offset
  const digest = await contentDigest([contents, cd, eocd], opts);

  const { identity } = opts;
  const signedDigests = lp(cat(lp(cat(u32(ALG_RSA_PKCS1_SHA256), lp(digest)))));
  const certs = lp(lp(identity.certificateDer));
  const attrs = lp(new Uint8Array(0));
  const signedData = cat(signedDigests, certs, attrs);
  const signature = await rsaSign(identity.privateKey, signedData);
  const spki = parseCertificate(identity.certificateDer).spki;
  const signer = cat(
    lp(signedData),
    lp(lp(cat(u32(ALG_RSA_PKCS1_SHA256), lp(signature)))),
    lp(spki),
  );
  const value = lp(lp(signer));
  const pair = cat(u64(4 + value.length), u32(V2_BLOCK_ID), value);
  const sizeField = pair.length + 8 + 16;
  const block = cat(u64(sizeField), pair, u64(sizeField), enc.encode('APK Sig Block 42'));

  const newEocd = eocd.slice();
  new DataView(newEocd.buffer, newEocd.byteOffset).setUint32(16, cdOffset + block.length, true);
  return cat(contents, block, cd, newEocd);
}

// ------------------------------------------------------------------ top level

/** Signs an already parsed archive (v1 + v2) without a serialize/parse round trip. Mutates `zip`. */
export async function signZip(zip: ZipArchive, opts: SignOptions): Promise<Uint8Array> {
  removeSignatureFiles(zip);
  const minSdk = opts.minSdk ?? detectMinSdk(zip);
  const { manifest, sf, rsa } = await v1Files(zip, { ...opts, minSdk });
  setEntry(zip, { name: 'META-INF/MANIFEST.MF', data: manifest, method: 8 });
  setEntry(zip, { name: `${SIG_BASE}.SF`, data: sf, method: 8 });
  setEntry(zip, { name: `${SIG_BASE}.RSA`, data: rsa, method: 8 });
  throwIfCancelled(opts.signal);
  opts.onProgress?.(0.9);
  const aligned = writeZip(zip);
  throwIfCancelled(opts.signal);
  return buildV2Block(aligned, opts);
}

export async function signApk(apk: Uint8Array, opts: SignOptions): Promise<Uint8Array> {
  return signZip(readZip(apk), opts);
}
