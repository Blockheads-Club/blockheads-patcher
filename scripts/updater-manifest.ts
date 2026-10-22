// Writes the Tauri updater manifest latest.json into a folder of release assets (release.yml, publish job).
//   bun scripts/updater-manifest.ts <dir> <version> <tag>
// Every `<asset>.sig` in <dir> is the minisign signature of <asset>; the logic lives in @bh-patcher/core (tested).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildUpdaterManifest } from '../packages/core/src/update';

const [dir, version, tag] = process.argv.slice(2);
if (!dir || !version || !tag) throw new Error('usage: bun scripts/updater-manifest.ts <dir> <version> <tag>');
const files: Record<string, string> = {};
for (const f of readdirSync(dir)) if (f.endsWith('.sig')) files[f.slice(0, -4)] = readFileSync(join(dir, f), 'utf8');
const manifest = buildUpdaterManifest({
  version, tag, files, pubDate: new Date().toISOString(),
  notes: `https://github.com/Blockheads-Club/blockheads-patcher/releases/tag/${tag}`
});
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json: ${Object.keys(manifest.platforms).join(', ')}`);
