import type { PlatformAdapter } from './types';
import { pickApkWithDialog, saveWithDialog } from './tauri-common';

/** Windows/Linux/macOS Tauri shell: native dialogs + scoped fs. No Android-only capabilities. */
export function createTauriDesktopAdapter(): PlatformAdapter {
  return {
    kind: 'tauri-desktop',
    pickApk: pickApkWithDialog,
    saveOutput: saveWithDialog
  };
}
