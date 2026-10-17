import adapter from '@sveltejs/adapter-static';

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
