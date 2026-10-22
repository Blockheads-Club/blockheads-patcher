// The mod loader build for the "Add the mod loader" patch: served next to the app (`mod-loader/<file>`, put there at
// build time by scripts/fetch-mod-loader.ts) and checked against the pin before use.
import { MOD_LOADER_PIN, modLoaderFileName, type ModLoaderPin } from '@bh-patcher/core';

/** A PatchError-shaped error (classifyError reads `name` and `code`). */
export function modLoaderError(message: string): Error {
  return Object.assign(new Error(message), { name: 'PatchError', code: 'modLoaderUnavailable', params: { message } });
}

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** Downloads the pinned loader zip from `base` and checks its size and SHA-256. */
export async function fetchModLoader(fetchImpl: typeof fetch = fetch, base = '', pin: ModLoaderPin = MOD_LOADER_PIN): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/mod-loader/${modLoaderFileName(pin)}`);
  } catch (e) {
    throw modLoaderError(`the loader file could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) throw modLoaderError(`the loader file is missing from this Patcher build (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha = hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  if (bytes.length !== pin.size || sha !== pin.sha256) throw modLoaderError(`the loader file does not match the pinned build ${pin.version}`);
  return bytes;
}
