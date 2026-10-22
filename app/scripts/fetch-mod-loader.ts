// Puts the pinned mod loader zip into static/mod-loader/ so every app build (web, desktop, Android) serves it to the
// "Add the mod loader" patch. Source: BH_MOD_LOADER_ZIP (a local file) or the pinned release URL. The file must match
// the pin's SHA-256 and size. Without it the build still succeeds (the patch then reports the file as missing) unless
// BH_MOD_LOADER_REQUIRED=1. Usage: bun scripts/fetch-mod-loader.ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD_LOADER_PIN, modLoaderFileName } from '../../packages/core/src/patches/mod-loader';

const dir = join(import.meta.dir, '..', 'static', 'mod-loader');
const dest = join(dir, modLoaderFileName());
const ok = (b: Uint8Array) => b.length === MOD_LOADER_PIN.size && createHash('sha256').update(b).digest('hex') === MOD_LOADER_PIN.sha256;
const fail = (msg: string): never => {
  if (process.env.BH_MOD_LOADER_REQUIRED === '1') { console.error(`fetch-mod-loader: ${msg}`); process.exit(1); }
  console.warn(`fetch-mod-loader: ${msg} (continuing without the mod loader file)`);
  process.exit(0);
};

if (existsSync(dest) && ok(readFileSync(dest))) {
  console.log(`fetch-mod-loader: ${dest} is up to date`);
  process.exit(0);
}
let bytes: Uint8Array;
const local = process.env.BH_MOD_LOADER_ZIP;
if (local) {
  bytes = new Uint8Array(readFileSync(local));
} else {
  const res = await fetch(MOD_LOADER_PIN.url).catch((e: unknown) => fail(`download failed: ${String(e)}`));
  if (!res.ok) fail(`download failed: HTTP ${res.status} ${MOD_LOADER_PIN.url}`);
  bytes = new Uint8Array(await res.arrayBuffer());
}
if (!ok(bytes)) fail(`the file does not match the pinned build ${MOD_LOADER_PIN.version} (SHA-256 ${MOD_LOADER_PIN.sha256})`);
mkdirSync(dir, { recursive: true });
writeFileSync(dest, bytes);
console.log(`fetch-mod-loader: wrote ${dest}`);
