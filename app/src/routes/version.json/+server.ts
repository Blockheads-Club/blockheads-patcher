// The version of this build, prerendered to version.json. The web app compares it with the running version to offer
// a reload after blockheads.club deployed a new release (see src/lib/update.svelte.ts).
export const prerender = true;

export function GET(): Response {
  return new Response(JSON.stringify({ version: __APP_VERSION__ }), { headers: { 'content-type': 'application/json' } });
}
