export type PlatformKind = 'web' | 'tauri-desktop' | 'tauri-android';
export interface PickedApk { name: string; bytes: Uint8Array; source: 'file' | 'installed'; }
export interface InstalledGameInfo { packageName: string; versionName?: string; versionCode?: number; splitSourceDirs: string[]; }
export interface PlatformAdapter {
  kind: PlatformKind;
  /** File picker. Returns null if cancelled. */
  pickApk(): Promise<PickedApk | null>;
  /** The file name's extension (.apk / .json) selects the save-dialog filter. */
  saveOutput(name: string, bytes: Uint8Array): Promise<{ location?: string }>;
  // Android only (undefined elsewhere):
  getInstalledGame?(): Promise<InstalledGameInfo | null>;
  loadInstalledApk?(): Promise<PickedApk>;
  /** `completed` is false when the user cancelled the system dialog. */
  uninstallOriginal?(): Promise<{ started: boolean; completed?: boolean }>;
  /** Resolves on the installer's final status; 'pending' = handed to the system installer without a result. */
  installApk?(name: string, bytes: Uint8Array): Promise<{ started: boolean; status?: 'success' | 'pending' }>;
  canRequestInstalls?(): Promise<boolean>;
  openInstallSettings?(): Promise<void>;
}
export const GAME_PACKAGE = 'com.noodlecake.blockheads';
