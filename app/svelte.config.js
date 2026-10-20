import adapter from '@sveltejs/adapter-static';
import { readFileSync } from 'node:fs';

// The static start-up card in app.html shows the app version (%sveltekit.env.PUBLIC_APP_VERSION%).
process.env.PUBLIC_APP_VERSION ??= JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// BASE_PATH is set for sub-path hosting: "/patcher" (blockheads.club, scripts/build-worker.mjs) or
// "/blockheads-patcher" (GitHub Pages project site).
// Unset => relative assets (Tauri, local preview, release zip).
const base = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
    paths: { base, relative: base === '' }
  }
};
