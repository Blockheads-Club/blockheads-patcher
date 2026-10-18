import adapter from '@sveltejs/adapter-static';
import { readFileSync } from 'node:fs';

// The static start-up card in app.html shows the app version (%sveltekit.env.PUBLIC_APP_VERSION%).
process.env.PUBLIC_APP_VERSION ??= JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// BASE_PATH is set for sub-path hosting (GitHub Pages project site: "/blockheads-patcher").
// Unset => root-relative assets (Cloudflare Pages, Tauri, local preview).
const base = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
    paths: { base, relative: base === '' }
  }
};
