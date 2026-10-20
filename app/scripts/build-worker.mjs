// Builds the web app for the Cloudflare Worker "blockheads-patcher-web" (assets only, see /wrangler.toml), which
// blockheads.club serves at /patcher/ through a service binding from the website Worker.
//
// A Worker's static assets are matched by the full request path, so the build (made with BASE_PATH, default
// "/patcher") is staged under build-worker/<base>/. index.html is also copied to build-worker/index.html, the file
// `not_found_handling = "single-page-application"` serves for unknown navigation paths (deep links). _headers is
// rewritten for the prefixed paths; _redirects (the Cloudflare Pages SPA rule) and 404.html (GitHub Pages) are
// dropped because the SPA handling replaces them.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.BASE_PATH ?? '/patcher').replace(/\/+$/, '');
if (!/^\/[a-z0-9][a-z0-9/_-]*$/i.test(base)) throw new Error(`BASE_PATH must look like "/patcher", got "${base}"`);

const run = (cmd, args) => execFileSync(cmd, args, { cwd: app, stdio: 'inherit', env: { ...process.env, BASE_PATH: base } });
run('bun', ['run', 'build']);
run('node', ['scripts/finalize-web.mjs', 'build']);

const out = join(app, 'build-worker');
const dest = join(out, base);
rmSync(out, { recursive: true, force: true });
cpSync(join(app, 'build'), dest, { recursive: true });
for (const f of ['_redirects', '404.html', '.nojekyll', '_headers', '.gitkeep']) rmSync(join(dest, f), { force: true });
copyFileSync(join(dest, 'index.html'), join(out, 'index.html'));

// Prefix every path rule ("/*", "/_app/immutable/*") with the base; header lines are indented and stay as they are.
const headers = readFileSync(join(app, 'build', '_headers'), 'utf8')
  .split('\n')
  .map((line) => (line.startsWith('/') ? base + line : line))
  .join('\n');
writeFileSync(join(out, '_headers'), headers);
console.log(`build-worker: staged build under build-worker${base}/`);
