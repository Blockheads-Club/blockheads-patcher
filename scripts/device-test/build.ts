// Builds one test APK per patch set for device testing, signed with a reusable local test key.
// Usage: BH_APK=<original.apk> bun scripts/device-test/build.ts list | <name> <patchId...>
import { loadApk, listPatches, patchApk, MemoryKeystore, importIdentity } from '../../packages/core/src/index';
const INPUT = process.env.BH_APK ?? (() => { throw new Error('set BH_APK to the original APK'); })();
const KEY = new URL('../../.local-out/device-test/key.json', import.meta.url).pathname;
const OUT = new URL('../../.local-out/device-test/', import.meta.url).pathname;
const [name, ...ids] = process.argv.slice(2);
const bytes = new Uint8Array(await Bun.file(INPUT).arrayBuffer());
if (name === 'list') {
  for (const r of listPatches(await loadApk(bytes))) console.log(r.patch.id, r.status, JSON.stringify({ optIn: (r.patch as any).optIn }));
  process.exit(0);
}
const { generateIdentity, exportIdentityJson } = await import('../../packages/core/src/index');
const ks = new MemoryKeystore();
if (await Bun.file(KEY).exists()) await ks.set(await importIdentity(await Bun.file(KEY).text()));
else { const id = await generateIdentity(); await Bun.write(KEY, await exportIdentityJson(id)); await ks.set(id); }
const res = await patchApk(bytes, { patchIds: ids, keystore: ks });
await Bun.write(OUT + name + '.apk', res.bytes);
console.log(name, 'applied:', res.applied.join(','), res.certSha256.slice(0, 12));
