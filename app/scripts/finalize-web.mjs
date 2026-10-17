// Post-build step for the web deployment (GitHub Pages / Cloudflare Pages).
//  - writes the CSP script hash into build/_headers
//  - copies index.html to 404.html (SPA fallback for GitHub Pages)
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'build';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`
);
if (hashes.length === 0) throw new Error('no inline script found in index.html');

const headers = join(dir, '_headers');
if (existsSync(headers)) {
  writeFileSync(headers, readFileSync(headers, 'utf8').replaceAll('__SCRIPT_HASH__', hashes.join(' ')));
}
copyFileSync(join(dir, 'index.html'), join(dir, '404.html'));
console.log(`finalize-web: ${hashes.length} script hash(es), 404.html written`);
