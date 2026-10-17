// Usage: bun scripts/patch-cli.ts [--key identity.json] [--passphrase p] <input.apk> <output.apk> [patchId...]
// Without patch ids, every patch that applies to the APK is applied.
// --key: exported identity JSON; created (unencrypted unless --passphrase) if missing, so repeated runs keep one certificate.
import { existsSync } from 'node:fs';
import { patchApk, loadApk, listPatches, MemoryKeystore, generateIdentity, importIdentity, exportIdentityJson, exportIdentityEncryptedJson } from '../packages/core/src/index';

const args = process.argv.slice(2);
const take = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const keyPath = take('--key');
const passphrase = take('--passphrase');
const [input, output, ...ids] = args;
if (!input || !output) {
  console.error('usage: bun scripts/patch-cli.ts [--key identity.json] [--passphrase p] <input.apk> <output.apk> [patchId...]');
  process.exit(2);
}
const keystore = new MemoryKeystore();
if (keyPath) {
  if (existsSync(keyPath)) await keystore.set(await importIdentity(await Bun.file(keyPath).text(), passphrase));
  else {
    const id = await generateIdentity();
    await Bun.write(keyPath, passphrase ? await exportIdentityEncryptedJson(id, passphrase) : await exportIdentityJson(id));
    await keystore.set(id);
    console.log(`created new signing key ${keyPath}`);
  }
}
const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
const patchIds = ids.length ? ids : listPatches(await loadApk(bytes)).filter((r) => r.status === 'notApplied').map((r) => r.patch.id);
const res = await patchApk(bytes, { patchIds, keystore });
await Bun.write(output, res.bytes);
console.log(`wrote ${output} (${res.bytes.length} bytes); applied: ${res.applied.join(', ') || 'none'}; cert sha256 ${res.certSha256}`);
