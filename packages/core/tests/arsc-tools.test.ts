/**
 * Validation against the Android SDK tools (aapt2, apksigner): skipped when they are absent, and the real-APK
 * cases additionally when the user's game APKs are absent or BH_SKIP_REAL is set.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKeystore, getEntry, parseArsc, patchApk, readZip, serializeArsc, setEntry, writeZip, encodePng } from '../src';
import { build } from './axml-builder';
import { buildArsc, cfg } from './arsc-builder';
import { haveApk } from './helpers';
import { manifestTree } from './synthetic-apk';

const BT = join(homedir(), 'Android/Sdk/build-tools/35.0.0');
const tools = existsSync(join(BT, 'aapt2')) && existsSync(join(BT, 'apksigner'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function run(cmd: string, args: string[]): string {
  const r = spawnSync(join(BT, cmd), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '') + (r.stderr ?? '');
}
function inTmp(name: string, bytes: Uint8Array): string {
  const d = mkdtempSync(join(tmpdir(), 'bh-arsc-'));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, bytes);
  return p;
}

function checkPatched(apk: Uint8Array, iconKey: string): void {
  const p = inTmp('out.apk', apk);
  const verify = run('apksigner', ['verify', '--verbose', p]);
  expect(verify).toMatch(/Verified using v1 scheme \(JAR signing\): true/);
  expect(verify).toMatch(/Verified using v2 scheme \(APK Signature Scheme v2\): true/);
  const res = run('aapt2', ['dump', 'resources', p]);
  expect(res).toMatch(/\(anydpi-v26\) \(file\) res\/drawable-anydpi-v26\/icon\.xml type=XML/);
  expect(res).toMatch(/mipmap\/ic_launcher_foreground\n\s+\(nodpi\) \(file\) res\/mipmap-nodpi\/ic_launcher_foreground\.png type=PNG/);
  expect(res).toMatch(/color\/ic_launcher_background\n\s+\(\) #ff[0-9a-f]{6}/);
  expect(res).toMatch(/mipmap\/ic_launcher_round\n\s+\(\) @drawable\/icon\n\s+\(anydpi-v26\)/);
  expect(res).toContain(iconKey);
  const xml = run('aapt2', ['dump', 'xmltree', '--file', 'res/drawable-anydpi-v26/icon.xml', p]);
  expect(xml).toMatch(/E: adaptive-icon[\s\S]*E: background[\s\S]*android:drawable\(0x01010199\)=@0x7f[0-9a-f]{6}[\s\S]*E: foreground/);
  const manifest = run('aapt2', ['dump', 'xmltree', '--file', 'AndroidManifest.xml', p]);
  expect(manifest).toMatch(/android:roundIcon\(0x0101052c\)=@0x7f[0-9a-f]{2}0001/);
}

describe.skipIf(!tools)('aapt2 / apksigner accept the generated resources', () => {
  it('synthetic APK patched with adaptive-icon', async () => {
    const zip = { entries: [] as ReturnType<typeof readZip>['entries'] };
    const m = manifestTree({});
    m.children!.find((c) => c.name === 'application')!.attrs = [{ name: 'icon', res: 0x01010002, type: 0x01, data: 0x7f010000 }];
    setEntry(zip, { name: 'AndroidManifest.xml', data: build(m) });
    const pixels = Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => [30 + (i >> 8), 90, 200, 255][i & 3]!);
    setEntry(zip, { name: 'res/drawable/icon.png', data: encodePng({ width: 64, height: 64, rgba: pixels }) });
    setEntry(zip, { name: 'resources.arsc', method: 0, data: buildArsc({ packages: [{ types: [
      { name: 'drawable', configs: [{ config: cfg(), entries: [{ key: 'icon', value: { str: 'res/drawable/icon.png' } }] }] },
      { name: 'color', configs: [{ config: cfg(), entries: [{ key: 'other', value: { type: 0x1c, data: 0xff00ff00 } }] }] },
    ] }] }) });
    const res = await patchApk(writeZip(zip), { patchIds: ['adaptive-icon'], keystore: new MemoryKeystore() });
    checkPatched(res.bytes, 'drawable/icon');
  });
});

const APKS: [string, string][] = [
  ['1.7.4', '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk'],
  ['1.7.5', '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk'],
  ['1.7.6', process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk'],
];
for (const [name, path] of APKS) {
  describe.skipIf(!haveApk(path) || !tools)(`real APK ${name}: resource table`, () => {
    it('round-trips resources.arsc byte-identically and adds the adaptive icon without moving ids', async () => {
      const input = new Uint8Array(readFileSync(path));
      const arsc = getEntry(readZip(input), 'resources.arsc')!.data;
      expect(Buffer.from(serializeArsc(parseArsc(arsc))).equals(Buffer.from(arsc))).toBe(true);
      const res = await patchApk(input, { patchIds: ['adaptive-icon'], keystore: new MemoryKeystore() });
      expect(res.applied).toEqual(['adaptive-icon']);
      checkPatched(res.bytes, 'resource 0x7f02002c drawable/icon');
      const before = run('aapt2', ['dump', 'resources', inTmp('in.apk', input)]).split('\n').filter((l) => /^\s+resource 0x7f0[0-9a-f]/.test(l) && !/mipmap|ic_launcher_background/.test(l));
      const after = run('aapt2', ['dump', 'resources', inTmp('out.apk', res.bytes)]).split('\n').filter((l) => /^\s+resource 0x7f0[0-9a-f]/.test(l) && !/mipmap|ic_launcher_background/.test(l));
      expect(after).toEqual(before);
    }, 120_000);
  });
}
