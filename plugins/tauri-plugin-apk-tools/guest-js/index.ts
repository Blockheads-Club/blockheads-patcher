// Guest bindings for the apk-tools plugin. Contract: docs/ARCHITECTURE.md section 8.
// All commands reject with a string error ("unsupported" off Android).
import { invoke } from '@tauri-apps/api/core';

export type InstalledPackage =
  | { installed: false }
  | {
      installed: true;
      packageName: string;
      versionName?: string;
      versionCode: number;
      sourceDir: string;
      splitSourceDirs: string[];
    };

export interface InstalledApkFile {
  path: string;
  size: number;
  splitSourceDirs: string[];
}

const cmd = (name: string) => `plugin:apk-tools|${name}`;

export const getInstalledPackage = (packageName: string) =>
  invoke<InstalledPackage>(cmd('get_installed_package'), { packageName });
export const readInstalledApk = (packageName: string) =>
  invoke<InstalledApkFile>(cmd('read_installed_apk'), { packageName });
export const requestUninstall = (packageName: string) =>
  invoke<{ started: boolean; completed?: boolean }>(cmd('request_uninstall'), { packageName });
export const canRequestInstalls = () =>
  invoke<{ allowed: boolean }>(cmd('can_request_installs'), {});
export const openInstallSettings = () => invoke<void>(cmd('open_install_settings'), {});
/**
 * Resolves when the installer reports success (or, for the ACTION_VIEW fallback, status 'pending').
 * Rejects with "install_conflict: ...", "install_aborted: ...", "install_storage: ...", "install_failed: ...".
 */
export const installApk = (path: string) =>
  invoke<{ started: boolean; status?: 'success' | 'pending' }>(cmd('install_apk'), { path });

/** In-app update of the Patcher itself (Android): a release APK is downloaded natively, progress is polled. */
export interface UpdateDownloadStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  received: number;
  total: number;
  /** Absolute path of the verified APK once `state` is "done" (pass it to installApk). */
  path: string;
  error: string;
}
/** `sumsUrl`: the release's SHA256SUMS.txt (omitted or empty = size check only); the download fails when the file's SHA-256 is not listed there. */
export const updateDownload = (url: string, name: string, size: number, sumsUrl?: string) =>
  invoke<void>(cmd('update_download'), { url, name, size, sumsUrl: sumsUrl ?? '' });
export const updateStatus = () => invoke<UpdateDownloadStatus>(cmd('update_status'), {});
export const updateCancel = () => invoke<void>(cmd('update_cancel'), {});
