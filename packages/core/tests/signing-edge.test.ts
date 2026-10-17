import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash, createPublicKey, createVerify, X509Certificate } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { Asn1Error, parseDer, der as derOf } from '../src/signing/asn1';
import {
  der, generateIdentity, exportIdentity, exportIdentityEncrypted, exportIdentityEncryptedJson, importIdentity, isEncryptedBundle,
  IndexedDbKeystore, SigningError, signZip, signApk, v1Files, buildV2Block, detectMinSdk, type SigningIdentity,
} from '../src/signing';
import { fromBase64, parseCertificate, toBase64 } from '../src/signing/identity';
import { CancelledError } from '../src/abort';
import { readZip, writeZip, setEntry, getEntry, type ZipArchive } from '../src/zip';
import { build } from './axml-builder';
import { makeApk } from './synthetic-apk';
import { verifyV2 } from './verify';

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
let id: SigningIdentity;
beforeAll(async () => { id = await generateIdentity(); }, 30000);

describe('der encoder', () => {
  it('encodes integers as unsigned, minimal two-complement', () => {
    expect(hex(der.int(0n))).toBe('020100');
    expect(hex(der.int(new Uint8Array([0, 0, 0x7f])))).toBe('02017f');
    expect(hex(der.int(new Uint8Array([0, 0])))).toBe('020100');
    expect(hex(der.int(new Uint8Array([0, 0x80])))).toBe('02020080');
    expect(hex(der.int(new Uint8Array(0)))).toBe('020100');
    expect(hex(der.int(0x123456789abcdefn))).toBe('02080123456789abcdef');
    expect(() => der.int(-1n)).toThrow(Asn1Error);
  });
  it('encodes OIDs with multi-byte arcs and rejects short ones', () => {
    expect(hex(der.oid('2.5.4.3'))).toBe('0603550403');
    expect(hex(der.oid('1.2.840.113549'))).toBe('06062a864886f70d');
    expect(() => der.oid('1')).toThrow(/bad OID/);
  });
  it('encodes strings, booleans, context tags and long lengths', () => {
    expect(hex(der.printable('US'))).toBe('13025553');
    expect(hex(der.utf8('é'))).toBe('0c02c3a9');
    expect(hex(der.bool(true))).toBe('0101ff');
    expect(hex(der.bool(false))).toBe('010100');
    expect(hex(der.ctx(1, Uint8Array.of(5)))).toBe('a1' + '0105');
    expect(hex(der.ctx(2, Uint8Array.of(5), false))).toBe('820105');
    expect(hex(der.octets(new Uint8Array(300)).subarray(0, 4))).toBe('0482012c');
    expect(hex(der.octets(new Uint8Array(65536)).subarray(0, 5))).toBe('0483010000');
  });
});

describe('der decoder', () => {
  it('parses nested structures and exposes raw/content', () => {
    const inner = der.seq(der.int(5n), der.utf8('hi'));
    const outer = parseDer(der.seq(inner, der.bool(true)));
    const kids = outer.children();
    expect(kids.map((k) => k.tag)).toEqual([0x30, 0x01]);
    expect(hex(kids[0]!.raw)).toBe(hex(inner));
    expect(kids[0]!.children().map((k) => k.tag)).toEqual([0x02, 0x0c]);
    const big = parseDer(der.octets(new Uint8Array(300)));
    expect(big.content.length).toBe(300);
  });
  it('is strict about malformed input', () => {
    expect(() => parseDer(Uint8Array.of(0x30))).toThrow(/truncated/);
    expect(() => parseDer(Uint8Array.of(0x30, 0x80))).toThrow(/bad DER length/);
    expect(() => parseDer(Uint8Array.of(0x30, 0x85, 1, 2, 3, 4, 5))).toThrow(/bad DER length/);
    expect(() => parseDer(Uint8Array.of(0x30, 0x82, 1))).toThrow(/bad DER length/);
    expect(() => parseDer(Uint8Array.of(0x04, 0x05, 1))).toThrow(/exceeds buffer/);
    expect(() => parseDer(Uint8Array.of(0x04, 0x01, 1, 9))).toThrow(/trailing data/);
    expect(() => parseDer(Uint8Array.of(0x02, 0x01, 1)).children()).toThrow(/no children/);
  });
  it('allows trailing data when parsing at an offset', () => {
    const b = Uint8Array.of(0xff, 0x04, 0x01, 0x07, 0xee);
    expect(parseDer(b, 1).content[0]).toBe(7);
  });
  it('exports Asn1Error and the same encoder object', () => {
    expect(derOf).toBe(der);
  });
});

describe('identity generation and certificates', () => {
  it('honours commonName, validity and clock options', async () => {
    const now = new Date(Date.UTC(2040, 5, 1));
    const g = await generateIdentity({ commonName: 'Test CN', validityYears: 2, now });
    const cert = new X509Certificate(Buffer.from(g.certificateDer));
    expect(cert.subject).toContain('CN=Test CN');
    expect(cert.subject).toContain('O=Blockheads Patcher');
    expect(cert.issuer).toBe(cert.subject);
    expect(new Date(cert.validFrom).getUTCFullYear()).toBe(2040);
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2042);
    // validity after 2049 is encoded as GeneralizedTime but still parseable
    const far = await generateIdentity({ now: new Date(Date.UTC(2060, 0, 1)) });
    expect(new Date(new X509Certificate(Buffer.from(far.certificateDer)).validTo).getUTCFullYear()).toBe(2089);
    // the self-signature verifies
    const parts = parseDer(g.certificateDer).children();
    const v = createVerify('sha256');
    v.update(parts[0]!.raw);
    expect(v.verify(cert.publicKey, parts[2]!.content.subarray(1))).toBe(true);
  }, 30000);

  it('parseCertificate extracts issuer, serial and SPKI (v3 and versionless layouts)', () => {
    const parts = parseCertificate(id.certificateDer);
    const spki = createPublicKey({ key: Buffer.from(parts.spki), format: 'der', type: 'spki' });
    expect(spki.asymmetricKeyType).toBe('rsa');
    expect(parts.serial[0]).toBe(0x02);
    expect(parts.issuer[0]).toBe(0x30);
    // a TBS without the [0] version field shifts every index by one
    const f = parseDer(id.certificateDer).children()[0]!.children();
    const v1Tbs = der.seq(...f.slice(1).map((n) => n.raw));
    const v1 = parseCertificate(der.seq(v1Tbs, der.seq(der.oid('1.2.840.113549.1.1.11')), der.bitString(new Uint8Array(4))));
    expect(hex(v1.serial)).toBe(hex(parts.serial));
    expect(hex(v1.spki)).toBe(hex(parts.spki));
  });

  it('parseCertificate reports garbage as SigningError', () => {
    expect(() => parseCertificate(der.seq())).toThrow(/empty certificate/);
    expect(() => parseCertificate(der.seq(der.seq()))).toThrow(/malformed certificate/);
    expect(() => parseCertificate(der.seq(der.seq(der.int(1n))))).toThrow(/malformed certificate/);
    expect(() => parseCertificate(Uint8Array.of(1, 2, 3))).toThrow(/invalid certificate/);
    expect(() => parseCertificate(Uint8Array.of(1, 2, 3))).toThrow(SigningError);
    // a primitive element where a certificate sequence is expected
    expect(() => parseCertificate(der.int(1n))).toThrow(/invalid certificate: primitive element/);
  });

  it('base64 helpers round-trip large buffers and tolerate whitespace', () => {
    const big = new Uint8Array(100000).map((_, i) => (i * 13) & 255);
    expect(hex(fromBase64(toBase64(big)))).toBe(hex(big));
    expect(hex(fromBase64('AQID\n BAUG'))).toBe('010203040506');
  });
});

describe('identity export / import edge cases', () => {
  it('encrypted export needs a passphrase; the JSON helper emits a v2 bundle', async () => {
    await expect(exportIdentityEncrypted(id, '')).rejects.toThrow(/passphrase required/);
    const json = await exportIdentityEncryptedJson(id, 'pw');
    expect(isEncryptedBundle(json)).toBe(true);
    expect(JSON.parse(json).kdf.iterations).toBe(600000);
    const back = await importIdentity(json, 'pw');
    expect(hex(back.certificateDer)).toBe(hex(id.certificateDer));
  }, 30000);

  it('isEncryptedBundle handles objects, plain bundles and garbage', async () => {
    const plain = await exportIdentity(id);
    expect(isEncryptedBundle(plain)).toBe(false);
    expect(isEncryptedBundle(JSON.stringify(plain))).toBe(false);
    expect(isEncryptedBundle({ version: 2 })).toBe(true);
    expect(isEncryptedBundle('{not json')).toBe(false);
    expect(isEncryptedBundle(null)).toBe(false);
    expect(isEncryptedBundle('null')).toBe(false);
  });

  it('rejects unsupported or damaged bundles with SigningError', async () => {
    const enc2 = await exportIdentityEncrypted(id, 'pw', 1000);
    const bad = async (b: unknown, pass?: string) => { await expect(importIdentity(b as never, pass)).rejects.toBeInstanceOf(SigningError); };
    await bad(enc2); // no passphrase
    await bad({ ...enc2, kdf: undefined }, 'pw');
    await bad({ ...enc2, kdf: { ...enc2.kdf, name: 'scrypt' } }, 'pw');
    await bad({ ...enc2, kdf: { ...enc2.kdf, iterations: 1.5 } }, 'pw');
    await bad({ ...enc2, kdf: { ...enc2.kdf, iterations: 0 } }, 'pw');
    await bad({ ...enc2, kdf: { ...enc2.kdf, iterations: 10_000_001 } }, 'pw');
    await bad({ ...enc2, cipher: undefined }, 'pw');
    await bad({ ...enc2, cipher: { name: 'AES-128-CBC', iv: enc2.cipher.iv } }, 'pw');
    await bad({ ...enc2, ciphertext: 5 }, 'pw');
    await bad({ ...enc2, certificate: undefined }, 'pw');
    await bad({ ...enc2, ciphertext: toBase64(new Uint8Array(40)) }, 'pw'); // authentication failure
    await bad({ ...enc2, kdf: { ...enc2.kdf, salt: '***' } }, 'pw'); // undecodable
    await bad({ version: 3 });
    await bad('null');
    await bad({ version: 1, pkcs8: 5, certificate: 'AA==' });
    await bad({ version: 1, pkcs8: 'AA==', certificate: 5 });
    await expect(importIdentity({ ...(await exportIdentity(id)), pkcs8: toBase64(new Uint8Array(30)) })).rejects.toThrow(/cannot import key/);
  });
});

describe('IndexedDbKeystore plumbing', () => {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;
  afterEach(() => { (globalThis as { indexedDB?: unknown }).indexedDB = original; });

  it('uses the global indexedDB when no factory is passed', async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    const ks = new IndexedDbKeystore();
    expect(await ks.get()).toBeNull();
    await ks.set(id);
    expect(hex((await new IndexedDbKeystore().get())!.certificateDer)).toBe(hex(id.certificateDer));
  }, 30000);

  const req = (fire: (r: { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void }) => void) => {
    const r: { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => fire(r));
    return r;
  };
  /** A factory whose database opens fine but whose transaction misbehaves. */
  const fakeFactory = (txEvent: 'none' | 'error' | 'abort', requestFails = false): IDBFactory => {
    const tx: { error?: unknown; oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore(): unknown } = {
      objectStore: () => ({
        get: () => req((r) => {
          if (requestFails) { r.error = new Error('request failed'); r.onerror!(); return; }
          r.result = undefined; r.onsuccess!();
          tx.error = new Error('tx ' + txEvent);
          if (txEvent === 'error') tx.onerror!(); else if (txEvent === 'abort') tx.onabort!(); else tx.oncomplete!();
        }),
      }),
    };
    const db = { transaction: () => tx, close: () => {}, objectStoreNames: { contains: () => true } };
    return { open: () => req((r) => { r.result = db; r.onsuccess!(); }) } as unknown as IDBFactory;
  };

  it('propagates open, request, transaction-error and abort failures', async () => {
    const failingOpen = { open: () => req((r) => { r.error = new Error('open failed'); r.onerror!(); }) } as unknown as IDBFactory;
    await expect(new IndexedDbKeystore(failingOpen).get()).rejects.toThrow('open failed');
    await expect(new IndexedDbKeystore(fakeFactory('none', true)).get()).rejects.toThrow('request failed');
    await expect(new IndexedDbKeystore(fakeFactory('error')).get()).rejects.toThrow('tx error');
    await expect(new IndexedDbKeystore(fakeFactory('abort')).get()).rejects.toThrow('tx abort');
    expect(await new IndexedDbKeystore(fakeFactory('none')).get()).toBeNull();
  });

  it('creates the object store on upgrade only when missing', async () => {
    const factory = new IDBFactory();
    const ks = new IndexedDbKeystore(factory);
    await ks.set(id);
    await ks.clear();
    expect(await ks.get()).toBeNull();
  }, 30000);
});

describe('v1 (JAR) signature files', () => {
  it('skips directories and signature files, keeps lookalikes', async () => {
    const z: ZipArchive = { entries: [] };
    for (const n of ['d/', 'META-INF/MANIFEST.MF', 'META-INF/A.SF', 'META-INF/b.rsa', 'META-INF/C.DSA', 'META-INF/D.EC', 'META-INF/SIG-X',
      'META-INF/sub/keep.SF', 'META-INF/plain.txt', 'other/META-INF/x.SF', 'AndroidManifest.xml']) setEntry(z, { name: n, data: enc.encode(n), method: 8 });
    const { manifest } = await v1Files(z, { identity: id });
    const names = new TextDecoder().decode(manifest).split('\r\n').filter((l) => l.startsWith('Name: ')).map((l) => l.slice(6));
    expect(names).toEqual(['META-INF/sub/keep.SF', 'META-INF/plain.txt', 'other/META-INF/x.SF', 'AndroidManifest.xml']);
  });

  it('wraps names without splitting multi-byte UTF-8 sequences', async () => {
    const z: ZipArchive = { entries: [] };
    const name = 'a' + 'ü'.repeat(80);
    setEntry(z, { name, data: enc.encode('x'), method: 8 });
    const { manifest } = await v1Files(z, { identity: id });
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(manifest); // throws on a split sequence
    const unfolded = raw.replace(/\r\n /g, '');
    expect(unfolded).toContain('Name: ' + name);
    for (const line of raw.split('\r\n')) expect(enc.encode(line).length).toBeLessThanOrEqual(72);
  });

  it('digests match the entry bytes and the SF signature verifies; SHA-1 for old minSdk; Created-By is configurable', async () => {
    const z = readZip(makeApk());
    const { manifest, sf } = await v1Files(z, { identity: id, createdBy: 'Unit Test' });
    const mf = new TextDecoder().decode(manifest);
    const sfText = new TextDecoder().decode(sf);
    expect(mf).toContain('Created-By: Unit Test');
    const dex = getEntry(z, 'classes.dex')!;
    expect(mf).toContain(`Name: classes.dex\r\nSHA-256-Digest: ${createHash('sha256').update(dex.data).digest('base64')}\r\n`);
    expect(sfText).toContain(`SHA-256-Digest-Manifest: ${createHash('sha256').update(manifest).digest('base64')}`);

    const legacy = await v1Files(z, { identity: id, minSdk: 17 });
    expect(new TextDecoder().decode(legacy.manifest)).toContain('SHA1-Digest: ');
    expect(new TextDecoder().decode(legacy.sf)).toContain('SHA1-Digest-Manifest: ');
    const modern = await v1Files(z, { identity: id, minSdk: 18 });
    expect(new TextDecoder().decode(modern.manifest)).toContain('SHA-256-Digest: ');

    // PKCS#7 contains the certificate and a signature over the SF that verifies with the cert key
    const signed = await v1Files(z, { identity: id });
    const cms = parseDer(signed.rsa);
    const signedData = cms.children()[1]!.children()[0]!.children();
    const cert = new X509Certificate(Buffer.from(signedData[3]!.children()[0]!.raw));
    const signerInfo = signedData[4]!.children()[0]!.children();
    const signature = signerInfo[4]!.content;
    const v = createVerify('sha256');
    v.update(signed.sf);
    expect(v.verify(cert.publicKey, signature)).toBe(true);
  });
});

describe('detectMinSdk', () => {
  const zipWith = (manifest?: Uint8Array): ZipArchive => {
    const z: ZipArchive = { entries: [] };
    if (manifest) setEntry(z, { name: 'AndroidManifest.xml', data: manifest });
    return z;
  };
  it('reads the declared value, defaults to 1, and gives up on missing or broken manifests', () => {
    expect(detectMinSdk(readZip(makeApk({ minSdk: 21 })))).toBe(21);
    expect(detectMinSdk(readZip(makeApk({ minSdk: null })))).toBe(1);
    expect(detectMinSdk(zipWith())).toBeUndefined();
    expect(detectMinSdk(zipWith(enc.encode('not axml at all')))).toBeUndefined();
    expect(detectMinSdk(zipWith(build({ name: 'application' })))).toBeUndefined();
  });
});

describe('signing a synthetic APK (verified with node:crypto, no apksigner needed)', () => {
  it('produces a v2 block whose digest and signature verify, and a v1 signature set', async () => {
    const big = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 7) & 255); // spans three 1 MiB chunks
    const apk = makeApk({}, [{ name: 'assets/big.bin', data: big, method: 0 }, { name: 'lib/arm64-v8a/libx.so', data: enc.encode('so'), method: 0 }]);
    const progress: number[] = [];
    const signed = await signApk(apk, { identity: id, onProgress: (f) => progress.push(f) });
    const r = verifyV2(signed);
    expect(r.digestOk).toBe(true);
    expect(r.signatureOk).toBe(true);
    expect(hex(r.certDer)).toBe(hex(id.certificateDer));
    expect(progress.at(-1)).toBe(0.9);
    const z = readZip(signed);
    for (const n of ['META-INF/MANIFEST.MF', 'META-INF/BHPATCH.SF', 'META-INF/BHPATCH.RSA']) expect(getEntry(z, n)).toBeDefined();
    // minSdk 21 in the manifest => SHA-256 JAR digests
    expect(new TextDecoder().decode(getEntry(z, 'META-INF/MANIFEST.MF')!.data)).toContain('SHA-256-Digest');
    // tampering with the payload breaks the digest
    const tampered = signed.slice();
    tampered[40] = tampered[40]! ^ 1;
    expect(verifyV2(tampered).digestOk).toBe(false);
  }, 60000);

  it('uses SHA-1 JAR digests when the manifest declares minSdk < 18, and an explicit minSdk wins', async () => {
    const old = readZip(makeApk({ minSdk: 9 }));
    const out = readZip(await signZip(old, { identity: id }));
    expect(new TextDecoder().decode(getEntry(out, 'META-INF/MANIFEST.MF')!.data)).toContain('SHA1-Digest');
    const forced = readZip(await signZip(readZip(makeApk({ minSdk: 9 })), { identity: id, minSdk: 24 }));
    expect(new TextDecoder().decode(getEntry(forced, 'META-INF/MANIFEST.MF')!.data)).toContain('SHA-256-Digest');
  }, 30000);

  it('replaces stale signature files', async () => {
    const z = readZip(makeApk({}, [{ name: 'META-INF/OLD.SF', data: enc.encode('x') }, { name: 'META-INF/OLD.RSA', data: enc.encode('x') }]));
    const out = readZip(await signZip(z, { identity: id }));
    expect(getEntry(out, 'META-INF/OLD.SF')).toBeUndefined();
    expect(getEntry(out, 'META-INF/BHPATCH.SF')).toBeDefined();
  });
});

describe('buildV2Block', () => {
  it('signs an archive with no entries (no digest chunks for empty sections)', async () => {
    const out = await buildV2Block(writeZip({ entries: [] }), { identity: id });
    expect(verifyV2(out).signatureOk).toBe(true);
    expect(verifyV2(out).digestOk).toBe(true);
  });

  it('rejects input that already carries a signing block', async () => {
    const signed = await signApk(makeApk(), { identity: id });
    await expect(buildV2Block(signed, { identity: id })).rejects.toThrow(/already contains an APK Signing Block/);
    await expect(buildV2Block(signed, { identity: id })).rejects.toBeInstanceOf(SigningError);
  });

  it('can be cancelled while hashing', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(buildV2Block(writeZip(readZip(makeApk())), { identity: id, signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('signZip cancellation points', () => {
  it('stops once the v1 stage is done', async () => {
    const zip = readZip(makeApk());
    const n = zip.entries.length;
    const ac = new AbortController();
    let calls = 0;
    const run = signZip(zip, { identity: id, signal: ac.signal, onProgress: () => { if (++calls === n) ac.abort(); } });
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toBe(n);
  }, 30000);

  it('stops after the archive was serialized', async () => {
    const ac = new AbortController();
    const run = signZip(readZip(makeApk()), { identity: id, signal: ac.signal, onProgress: (f) => { if (f === 0.9) ac.abort(); } });
    await expect(run).rejects.toBeInstanceOf(CancelledError);
  }, 30000);
});
