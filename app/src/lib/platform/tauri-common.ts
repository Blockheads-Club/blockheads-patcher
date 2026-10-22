import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl as openerOpenUrl } from '@tauri-apps/plugin-opener';
import type { UpdateTarget } from '@bh-patcher/core';
import { open as openFile, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { get } from 'svelte/store';
import { t } from '../i18n';
import type { PickedApk, PickedFile } from './types';

export const GAME_PACKAGE = 'com.noodlecake.blockheads';

/** File-dialog filters, named in the UI language. */
const APK_FILTER = () => [{ name: get(t)('filter.apk'), extensions: ['apk'] }];
const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];
const PACK_FILTER = () => [{ name: get(t)('filter.pack'), extensions: ['bhpack', 'zip'] }];

/** Save-dialog filter derived from the file name's extension. */
export function filterFor(name: string): { name: string; extensions: string[] }[] {
  return name.toLowerCase().endsWith('.json') ? JSON_FILTER : APK_FILTER();
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
  const selected = await open({ multiple: false, directory: false, filters: APK_FILTER() });
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

/** `filter: false` shows every file (Android's picker filters by MIME type, which .bhpack does not have). */
export async function pickPackWithDialog(filter = true): Promise<PickedFile | null> {
  const selected = await open({ multiple: false, directory: false, ...(filter ? { filters: PACK_FILTER() } : {}) });
  if (!selected) return null;
  const path = Array.isArray(selected) ? selected[0] : selected;
  return { name: baseName(path), bytes: await readFile(path) };
}

/** Opens a web page in the system browser (Android: the default app for the URL, e.g. the browser's downloader). */
export async function openExternal(url: string): Promise<void> {
  await openerOpenUrl(url);
}

/** OS and CPU architecture of this build (Rust command `update_target`). */
export function updateTarget(): Promise<UpdateTarget> {
  return invoke<UpdateTarget>('update_target');
}
