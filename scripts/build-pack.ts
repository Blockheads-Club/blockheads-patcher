// Usage: bun scripts/build-pack.ts <pack folder> [output.bhpack]
// Packs every file of the folder (pack.json at its root) into a deterministic .bhpack and validates it exactly like the
// app does on import. Exits non-zero, writing nothing, when the pack would be refused.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { buildPackArchive, loadPack } from '../packages/core/src/packs';

const [dir, out] = process.argv.slice(2);
if (!dir) {
  console.error('usage: bun scripts/build-pack.ts <pack folder> [output.bhpack]');
  process.exit(2);
}

const files: Record<string, Uint8Array> = {};
const walk = (d: string): void => {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(dir, p).split(sep).join('/')] = new Uint8Array(readFileSync(p));
  }
};
walk(dir);

const bytes = buildPackArchive(files);
const r = loadPack(bytes);
if (!r.ok) {
  console.error(`${dir}: the pack would be refused:`);
  for (const e of r.errors) console.error(`  [${e.code}] ${e.message}`);
  process.exit(1);
}
const target = out ?? `${r.pack.id}-${r.pack.version}.bhpack`;
await Bun.write(target, bytes);
console.log(`${basename(target)}: ${r.pack.name.en} ${r.pack.version}, ${r.pack.patches.length} patch(es), ${bytes.length} bytes, sha256 ${r.pack.sha256}`);
for (const p of r.pack.patches) console.log(`  ${p.id}`);
