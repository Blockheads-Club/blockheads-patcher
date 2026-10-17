import { appCacheDir, join } from '@tauri-apps/api/path';
import { mkdir, readFile, remove } from '@tauri-apps/plugin-fs';
import * as apk from '@bh-patcher/tauri-plugin-apk-tools-api';
import type { InstalledGameInfo, PickedApk, PlatformAdapter } from './types';
import { GAME_PACKAGE, pickApkWithDialog, safeFileName, saveWithDialog, writeFileChunked } from './tauri-common';

/** Directory inside the app cache that the Kotlin plugin is allowed to touch. */
async function workDir(): Promise<string> {
  const dir = await join(await appCacheDir(), 'bhp');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Android Tauri shell. The Kotlin plugin copies the installed base.apk into cache/bhp and JS reads it with
 * plugin-fs (responses come back over a binary channel). Requests have no such channel on Android: every
 * argument is JSON-serialized, so patched output is written to cache/bhp in bounded chunks
 * (writeFileChunked) and handed to the installer by path.
 */
export function createTauriAndroidAdapter(): PlatformAdapter {
  return {
    kind: 'tauri-android',
    pickApk: pickApkWithDialog,

    async saveOutput(name, bytes) {
      try {
        return await saveWithDialog(name, bytes);
      } catch {
        // Fallback when the system save dialog is unavailable: keep the file in the app cache.
        const path = await join(await workDir(), safeFileName(name));
        await writeFileChunked(path, bytes);
        return { location: path };
      }
    },

    async getInstalledGame(): Promise<InstalledGameInfo | null> {
      const info = await apk.getInstalledPackage(GAME_PACKAGE);
      if (!info.installed) return null;
      return {
        packageName: info.packageName,
        versionName: info.versionName,
        versionCode: info.versionCode,
        splitSourceDirs: info.splitSourceDirs
      };
    },

    async loadInstalledApk(): Promise<PickedApk> {
      const res = await apk.readInstalledApk(GAME_PACKAGE);
      if (res.splitSourceDirs?.length) {
        await remove(res.path).catch(() => undefined);
        throw new Error('unsupported: installed game uses split APKs');
      }
      try {
        const bytes = await readFile(res.path);
        return { name: `${GAME_PACKAGE}-base.apk`, bytes, source: 'installed' };
      } finally {
        await remove(res.path).catch(() => undefined);
      }
    },

    uninstallOriginal: async () => {
      const r = await apk.requestUninstall(GAME_PACKAGE);
      return { started: r.started, completed: r.completed };
    },

    async installApk(name, bytes) {
      const path = await join(await workDir(), safeFileName(name));
      await writeFileChunked(path, bytes);
      return apk.installApk(path);
    },

    canRequestInstalls: async () => (await apk.canRequestInstalls()).allowed,
    openInstallSettings: () => apk.openInstallSettings()
  };
}
