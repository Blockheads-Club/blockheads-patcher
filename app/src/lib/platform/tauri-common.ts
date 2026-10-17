import { open, save } from '@tauri-apps/plugin-dialog';
import { open as openFile, readFile, writeFile } from '@tauri-apps/plugin-fs';
import type { PickedApk } from './types';

export const GAME_PACKAGE = 'com.noodlecake.blockheads';

const APK_FILTER = [{ name: 'Android package', extensions: ['apk'] }];
const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];

/** Save-dialog filter derived from the file name's extension. */
export function filterFor(name: string): { name: string; extensions: string[] }[] {
  return name.toLowerCase().endsWith('.json') ? JSON_FILTER : APK_FILTER;
}

/**
 * Tauri's IPC on Android has no binary channel for requests: every argument is JSON-serialized, so a
 * ~100 MB Uint8Array in one writeFile call would blow up the WebView. Large payloads are written in
 * bounded chunks through a file handle instead.
 */
export const WRITE_CHUNK = 1 << 20;

export async function writeFileChunked(path: string, bytes: Uint8Array): Promise<void> {
  if (bytes.length <= WRITE_CHUNK) {
    await writeFile(path, bytes);
    return;
  }
  const f = await openFile(path, { write: true, create: true, truncate: true });
  try {
    for (let i = 0; i < bytes.length; ) {
      const n = await f.write(bytes.subarray(i, i + WRITE_CHUNK));
      if (!(n > 0)) throw new Error(`short write at offset ${i}`);
      i += n;
    }
  } finally {
    await f.close();
  }
}

/** Last path segment (handles `/`, `\` and content:// URIs with encoded separators). */
export function baseName(path: string): string {
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  const seg = p.split(/[\\/:]/).filter(Boolean).pop() ?? 'game.apk';
  return seg;
}

/** Make a name safe for use as a single file name inside the cache directory. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned || 'patched.apk';
}

export async function pickApkWithDialog(): Promise<PickedApk | null> {
  const selected = await open({ multiple: false, directory: false, filters: APK_FILTER });
  if (!selected) return null;
  const path = Array.isArray(selected) ? selected[0] : selected;
  const bytes = await readFile(path);
  return { name: baseName(path), bytes, source: 'file' };
}

export async function saveWithDialog(name: string, bytes: Uint8Array): Promise<{ location?: string }> {
  const target = await save({ defaultPath: name, filters: filterFor(name) });
  if (!target) return {};
  await writeFileChunked(target, bytes);
  return { location: target };
}
