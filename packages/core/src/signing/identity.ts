import { der, parseDer } from './asn1';
import { SigningError } from './errors';

export interface SigningIdentity {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  certificateDer: Uint8Array;
}
export interface IdentityBundle {
  version: 1;
  pkcs8: string;
  certificate: string;
}
/** Passphrase-protected bundle: PBKDF2-SHA256 -> AES-256-GCM over the PKCS#8 key. */
export interface EncryptedIdentityBundle {
  version: 2;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  cipher: { name: 'AES-256-GCM'; iv: string };
  ciphertext: string;
  certificate: string;
}
const PBKDF2_ITERATIONS = 600_000;

const RSA_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';

const subtle = () => globalThis.crypto.subtle;
const buf = (u: Uint8Array) => u as unknown as BufferSource;

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function name(cn: string): Uint8Array {
  const rdn = (oid: string, v: string) => der.set(der.seq(der.oid(oid), der.utf8(v)));
  return der.seq(rdn(OID_O, 'Blockheads Patcher'), rdn(OID_CN, cn));
}

export async function generateIdentity(
  opts: { commonName?: string; validityYears?: number; now?: Date } = {},
): Promise<SigningIdentity> {
  const cn = opts.commonName ?? 'Blockheads Patcher';
  const now = opts.now ?? new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + (opts.validityYears ?? 30));

  const kp = (await subtle().generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey('spki', kp.publicKey));

  const serial = new Uint8Array(16);
  globalThis.crypto.getRandomValues(serial);
  serial[0] = (serial[0] as number) & 0x7f; // positive

  const sigAlg = der.seq(der.oid(OID_SHA256_RSA), der.nul());
  const subject = name(cn);
  const tbs = der.seq(
    der.ctx(0, der.int(2n)), // v3
    der.int(serial),
    sigAlg,
    subject,
    der.seq(der.utcTime(notBefore), der.utcTime(notAfter)),
    subject,
    spki,
  );
  const sig = new Uint8Array(await subtle().sign('RSASSA-PKCS1-v1_5', kp.privateKey, buf(tbs)));
  const certificateDer = der.seq(tbs, sigAlg, der.bitString(sig));
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, certificateDer };
}

export interface CertParts {
  issuer: Uint8Array;
  serial: Uint8Array;
  spki: Uint8Array;
}

/** Extract issuer Name, serial INTEGER (full TLV) and SubjectPublicKeyInfo from an X.509 certificate. */
export function parseCertificate(certDer: Uint8Array): CertParts {
  try {
    const cert = parseDer(certDer);
    const tbs = cert.children()[0];
    if (!tbs) throw new SigningError('empty certificate');
    const f = tbs.children();
    const i = f[0] && f[0].tag === 0xa0 ? 1 : 0;
    const serial = f[i];
    const issuer = f[i + 2];
    const spki = f[i + 5];
    if (!serial || !issuer || !spki) throw new SigningError('malformed certificate');
    return { serial: serial.raw, issuer: issuer.raw, spki: spki.raw };
  } catch (e) {
    if (e instanceof SigningError) throw e;
    throw new SigningError(`invalid certificate: ${(e as Error).message}`);
  }
}

export async function exportIdentity(id: SigningIdentity): Promise<IdentityBundle> {
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', id.privateKey));
  return { version: 1, pkcs8: toBase64(pkcs8), certificate: toBase64(id.certificateDer) };
}
export async function exportIdentityJson(id: SigningIdentity): Promise<string> {
  return JSON.stringify(await exportIdentity(id), null, 2);
}

async function deriveAesKey(pass: string, salt: Uint8Array, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(new TextEncoder().encode(pass)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function exportIdentityEncrypted(
  id: SigningIdentity,
  passphrase: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<EncryptedIdentityBundle> {
  if (!passphrase) throw new SigningError('passphrase required');
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', id.privateKey));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, iterations, 'encrypt');
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(pkcs8)));
  return {
    version: 2,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
    cipher: { name: 'AES-256-GCM', iv: toBase64(iv) },
    ciphertext: toBase64(ct),
    certificate: toBase64(id.certificateDer),
  };
}
export async function exportIdentityEncryptedJson(id: SigningIdentity, passphrase: string): Promise<string> {
  return JSON.stringify(await exportIdentityEncrypted(id, passphrase), null, 2);
}

/** True if the (parsed or raw JSON) bundle needs a passphrase to import. */
export function isEncryptedBundle(b: unknown): boolean {
  try {
    const o = typeof b === 'string' ? JSON.parse(b) : b;
    return !!o && (o as { version?: number }).version === 2;
  } catch {
    return false;
  }
}

async function decryptBundle(b: EncryptedIdentityBundle, passphrase: string): Promise<IdentityBundle> {
  if (!passphrase) throw new SigningError('passphrase required');
  const iterations = b.kdf?.iterations;
  if (b.kdf?.name !== 'PBKDF2-SHA256' || !Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000 ||
      b.cipher?.name !== 'AES-256-GCM' || typeof b.ciphertext !== 'string' || typeof b.certificate !== 'string') {
    throw new SigningError('unsupported identity bundle');
  }
  try {
    const key = await deriveAesKey(passphrase, fromBase64(b.kdf.salt), iterations, 'decrypt');
    const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromBase64(b.cipher.iv)) }, key, buf(fromBase64(b.ciphertext))));
    return { version: 1, pkcs8: toBase64(pt), certificate: b.certificate };
  } catch {
    throw new SigningError('wrong passphrase or corrupted identity file');
  }
}

export async function importIdentity(b: IdentityBundle | EncryptedIdentityBundle | string, passphrase?: string): Promise<SigningIdentity> {
  let bundle: IdentityBundle | EncryptedIdentityBundle;
  try {
    bundle = typeof b === 'string' ? JSON.parse(b) : b;
  } catch {
    throw new SigningError('identity file is not valid JSON');
  }
  if (bundle && bundle.version === 2) bundle = await decryptBundle(bundle, passphrase ?? '');
  if (!bundle || bundle.version !== 1 || typeof bundle.pkcs8 !== 'string' || typeof bundle.certificate !== 'string') {
    throw new SigningError('unsupported identity bundle');
  }
  const certificateDer = fromBase64(bundle.certificate);
  const { spki } = parseCertificate(certificateDer);
  let privateKey: CryptoKey, publicKey: CryptoKey;
  try {
    privateKey = await subtle().importKey('pkcs8', buf(fromBase64(bundle.pkcs8)), RSA_ALG, true, ['sign']);
    publicKey = await subtle().importKey('spki', buf(spki), RSA_ALG, true, ['verify']);
  } catch (e) {
    throw new SigningError(`cannot import key: ${(e as Error).message}`);
  }
  const probe = new TextEncoder().encode('bh-patcher key check');
  const sig = await subtle().sign('RSASSA-PKCS1-v1_5', privateKey, buf(probe));
  if (!(await subtle().verify('RSASSA-PKCS1-v1_5', publicKey, sig, buf(probe)))) {
    throw new SigningError('private key does not match certificate');
  }
  return { privateKey, publicKey, certificateDer };
}
