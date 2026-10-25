import { appCacheDir, join } from '@tauri-apps/api/path';
import { mkdir, readFile, remove } from '@tauri-apps/plugin-fs';
import * as apk from '@bh-patcher/tauri-plugin-apk-tools-api';
import { INSTALL_NOT_ALLOWED, type AppUpdateFile, type InPlaceUpdate, type InstalledGameInfo, type PickedApk, type PlatformAdapter } from './types';
import { createFsPackStore } from './packs-fs';
import { GAME_PACKAGE, openExternal, pickApkWithDialog, pickPackWithDialog, safeFileName, saveWithDialog, updateTarget, writeFileChunked } from './tauri-common';

/** Directory inside the app cache that the Kotlin plugin is allowed to touch. */
async function workDir(): Promise<string> {
  const dir = await join(await appCacheDir(), 'bhp');
  await mkdir(dir, { recursive: true });
  return dir;
}

const POLL_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The app update as an InPlaceUpdate: the Kotlin plugin downloads the release APK and verifies size and checksum
 * (progress is polled), `install()` hands it to the system installer. When Android does not yet allow this app to
 * install packages, `install()` opens that settings screen and rejects with INSTALL_NOT_ALLOWED.
 */
export function openAppUpdate(file: AppUpdateFile, version: string): InPlaceUpdate {
  let path = '';
  return {
    version,
    async download(onProgress) {
      await apk.updateDownload(file.url, file.name, file.size, file.sumsUrl);
      for (;;) {
        await sleep(POLL_MS);
        const s = await apk.updateStatus();
        onProgress({ done: s.received, total: s.total > 0 ? s.total : null });
        if (s.state === 'done') { path = s.path; return; }
        if (s.state === 'error') throw new Error(s.error);
        if (s.state === 'idle') throw new Error('the download was cancelled');
      }
    },
    async install() {
      if (!(await apk.canRequestInstalls()).allowed) {
        await apk.openInstallSettings();
        throw new Error(INSTALL_NOT_ALLOWED);
      }
      await apk.installApk(path);
    },
    close: () => apk.updateCancel()
  };
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
    openUrl: openExternal,
    updateTarget,
    openAppUpdate,
    pickApk: pickApkWithDialog,
    packStore: createFsPackStore(),
    pickPack: () => pickPackWithDialog(false),

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
