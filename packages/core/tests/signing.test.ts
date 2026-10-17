import { haveFile } from './helpers';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { IDBFactory } from 'fake-indexeddb';
import {
  der, generateIdentity, exportIdentity, exportIdentityJson, importIdentity, MemoryKeystore, IndexedDbKeystore,
  getOrCreateIdentity, signApk, v1Files, SigningError,
} from '../src/signing';
import { readZip, getEntry } from '../src/zip';

const APKSIGNER = join(homedir(), 'Android/Sdk/build-tools/35.0.0/apksigner');
const REAL_APK = '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk';
const tmp = mkdtempSync(join(tmpdir(), 'bh-sign-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const haveSigner = haveFile(APKSIGNER);

function verify(bytes: Uint8Array, name: string, minSdk?: number) {
  const p = join(tmp, name);
  writeFileSync(p, bytes);
  const r = spawnSync(APKSIGNER, ['verify', '--verbose', '--print-certs', ...(minSdk ? ['--min-sdk-version', String(minSdk)] : []), p], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function syntheticApk(): Uint8Array {
  const enc = new TextEncoder();
  const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
  return zipSync({
    'AndroidManifest.xml': [enc.encode('manifest-bytes'), { level: 0 }],
    'classes.dex': [enc.encode('dex '.repeat(1000)), { level: 6 }],
    'assets/big.bin': [big, { level: 0 }],
    ['res/a-very-long-name/' + 'x'.repeat(90) + '.png']: [enc.encode('png'), { level: 0 }],
    'lib/arm64-v8a/libfoo.so': [enc.encode('so'), { level: 0 }],
    'META-INF/OLD.SF': enc.encode('stale'),
    'META-INF/MANIFEST.MF': enc.encode('Manifest-Version: 1.0\r\n\r\n'),
  });
}

describe('der', () => {
  it('encodes known values', () => {
    expect(hex(der.int(0n))).toBe('020100');
    expect(hex(der.int(128n))).toBe('02020080');
    expect(hex(der.int(new Uint8Array([0xff])))).toBe('020200ff');
    expect(hex(der.oid('1.2.840.113549.1.1.11'))).toBe('06092a864886f70d01010b');
    expect(hex(der.octets(new Uint8Array(200)).subarray(0, 3))).toBe('0481c8');
    expect(hex(der.utcTime(new Date(Date.UTC(2030, 0, 2, 3, 4, 5))))).toBe(hex(new Uint8Array([0x17, 13, ...new TextEncoder().encode('300102030405Z')])));
    expect(der.utcTime(new Date(Date.UTC(2056, 0, 1)))[0]).toBe(0x18);
  });
});

describe('identity', () => {
  let id: Awaited<ReturnType<typeof generateIdentity>>;
  beforeAll(async () => { id = await generateIdentity(); }, 30000);

  it('generates a cert openssl accepts', () => {
    const p = join(tmp, 'c.der');
    writeFileSync(p, id.certificateDer);
    const r = spawnSync('openssl', ['x509', '-inform', 'der', '-in', p, '-noout', '-subject', '-text'], { encoding: 'utf8' });
    if (r.error) return; // openssl absent
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sha256WithRSAEncryption');
    expect(r.stdout).toContain('Public-Key: (2048 bit)');
  });

  it('exports and imports round-trip', async () => {
    const json = await exportIdentityJson(id);
    const back = await importIdentity(json);
    expect(hex(back.certificateDer)).toBe(hex(id.certificateDer));
    const again = await importIdentity(await exportIdentity(back));
    expect(hex(again.certificateDer)).toBe(hex(id.certificateDer));
  });

  it('rejects mismatched key/cert and garbage', async () => {
    const other = await generateIdentity();
    const a = await exportIdentity(id);
    const b = await exportIdentity(other);
    await expect(importIdentity({ ...a, certificate: b.certificate })).rejects.toBeInstanceOf(SigningError);
    await expect(importIdentity('not json')).rejects.toBeInstanceOf(SigningError);
    await expect(importIdentity({ version: 1, pkcs8: 'AAAA', certificate: 'AAAA' })).rejects.toBeInstanceOf(SigningError);
  });
});

describe('keystores', () => {
  it('memory keystore getOrCreate is stable', async () => {
    const ks = new MemoryKeystore();
    const a = await getOrCreateIdentity(ks);
    const b = await getOrCreateIdentity(ks);
    expect(b).toBe(a);
    await ks.clear();
    expect(await ks.get()).toBeNull();
  });

  it('indexeddb keystore persists CryptoKeys', async () => {
    const factory = new IDBFactory();
    const ks = new IndexedDbKeystore(factory);
    expect(await ks.get()).toBeNull();
    const a = await getOrCreateIdentity(ks);
    const reopened = new IndexedDbKeystore(factory);
    const b = await reopened.get();
    expect(b).not.toBeNull();
    expect(hex(b!.certificateDer)).toBe(hex(a.certificateDer));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', b!.privateKey, new Uint8Array([1, 2, 3]));
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', a.publicKey, sig, new Uint8Array([1, 2, 3]))).toBe(true);
    await reopened.clear();
    expect(await ks.get()).toBeNull();
  }, 30000);
});

describe('v1 files', () => {
  it('wraps long lines at 72 bytes and omits signature files', async () => {
    const id = await generateIdentity();
    const zip = readZip(syntheticApk());
    const { manifest, sf } = await v1Files(zip, { identity: id });
    const text = new TextDecoder().decode(manifest);
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(72);
    expect(text).not.toContain('OLD.SF');
    expect(new TextDecoder().decode(sf)).toContain('X-Android-APK-Signed: 2');
  });
});

describe.skipIf(!haveSigner)('apksigner verification (synthetic)', () => {
  let id: Awaited<ReturnType<typeof generateIdentity>>;
  beforeAll(async () => { id = await generateIdentity(); }, 30000);

  it('signs with v1 + v2', async () => {
    const out = await signApk(syntheticApk(), { identity: id });
    const r = verify(out, 'syn.apk', 21);
    expect(r.out).toContain('Verified using v1 scheme (JAR signing): true');
    expect(r.out).toContain('Verified using v2 scheme (APK Signature Scheme v2): true');
    expect(r.status).toBe(0);
    const z = readZip(out);
    expect(getEntry(z, 'META-INF/BHPATCH.RSA')).toBeDefined();
    expect(getEntry(z, 'META-INF/OLD.SF')).toBeUndefined();
  }, 60000);

  it('re-signs an already signed APK with the same cert', async () => {
    const once = await signApk(syntheticApk(), { identity: id });
    const twice = await signApk(once, { identity: id });
    const r1 = verify(once, 'once.apk', 21);
    const r2 = verify(twice, 'twice.apk', 21);
    expect(r2.status).toBe(0);
    const sha = (s: string) => /certificate SHA-256 digest: (\w+)/.exec(s)?.[1];
    expect(sha(r2.out)).toBeTruthy();
    expect(sha(r2.out)).toBe(sha(r1.out));
  }, 60000);

  it('detects tampering', async () => {
    const out = await signApk(syntheticApk(), { identity: id });
    const bad = out.slice();
    bad[100] = (bad[100] as number) ^ 0xff;
    expect(verify(bad, 'bad.apk', 21).status).not.toBe(0);
  }, 60000);

  it('uses SHA-1 JAR digests for minSdk < 18', async () => {
    const out = await signApk(syntheticApk(), { identity: id, minSdk: 12 });
    const r = verify(out, 'legacy.apk', 12);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Verified using v1 scheme (JAR signing): true');
    expect(r.out).toContain('Verified using v2 scheme (APK Signature Scheme v2): true');
  }, 60000);

  it('keeps cert across export/import', async () => {
    const imported = await importIdentity(await exportIdentityJson(id));
    const out = await signApk(syntheticApk(), { identity: imported });
    expect(verify(out, 'imp.apk', 21).status).toBe(0);
  }, 60000);
});

describe.skipIf(!haveSigner || !haveFile(REAL_APK))('apksigner verification (real APK)', () => {
  it('signs the real APK', async () => {
    const id = await generateIdentity();
    const out = await signApk(new Uint8Array(readFileSync(REAL_APK)), { identity: id });
    const r = verify(out, 'real.apk');
    expect(r.out).toContain('Verified using v1 scheme (JAR signing): true');
    expect(r.out).toContain('Verified using v2 scheme (APK Signature Scheme v2): true');
    expect(r.status).toBe(0);
  }, 300000);
});
