import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, readDir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import type { PackStore } from './types';

const EXT = '.bhpack';
/** Pack ids are already restricted to [a-z0-9._-]; this guards the file name independently. */
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

async function dir(): Promise<string> {
  const d = await join(await appDataDir(), 'packs');
  await mkdir(d, { recursive: true });
  return d;
}
async function fileOf(id: string): Promise<string> {
  if (!SAFE_ID.test(id)) throw new Error(`invalid pack id: ${id}`);
  return join(await dir(), `${id}${EXT}`);
}

/** Desktop and Android: imported packs as `<app data>/packs/<id>.bhpack` (app-private storage on Android). */
export function createFsPackStore(): PackStore {
  return {
    async list() {
      const d = await dir();
      const names = (await readDir(d)).filter((e) => e.isFile && e.name.endsWith(EXT) && SAFE_ID.test(e.name.slice(0, -EXT.length))).map((e) => e.name).sort();
      return Promise.all(names.map(async (n) => ({ id: n.slice(0, -EXT.length), bytes: await readFile(await join(d, n)) })));
    },
    async put(id, bytes) {
      await writeFile(await fileOf(id), bytes);
    },
    async remove(id) {
      const f = await fileOf(id);
      if (await exists(f)) await remove(f);
    },
  };
}
