export type PlatformKind = 'web' | 'tauri-desktop' | 'tauri-android';
export interface PickedApk { name: string; bytes: Uint8Array; source: 'file' | 'installed'; }
export interface InstalledGameInfo { packageName: string; versionName?: string; versionCode?: number; splitSourceDirs: string[]; }
/** A file the user picked or dropped. */
export interface PickedFile { name: string; bytes: Uint8Array; }
/** Persistent storage of imported patch packs (the raw .bhpack bytes, keyed by pack id), oldest first. */
export interface PackStore {
  list(): Promise<{ id: string; bytes: Uint8Array }[]>;
  put(id: string, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface PlatformAdapter {
  kind: PlatformKind;
  /** File picker. Returns null if cancelled. */
  pickApk(): Promise<PickedApk | null>;
  /** The file name's extension (.apk / .json) selects the save-dialog filter. */
  saveOutput(name: string, bytes: Uint8Array): Promise<{ location?: string }>;
  /** Where imported patch packs are kept (an in-memory store is used when absent). */
  packStore?: PackStore;
  /** File picker for a .bhpack. Returns null if cancelled. */
  pickPack?(): Promise<PickedFile | null>;
  /** Desktop shell: files dropped on the window (the webview gets no DOM drop events there). Resolves to an unsubscribe. */
  onFileDrop?(cb: (files: PickedFile[]) => void): Promise<() => void>;
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
