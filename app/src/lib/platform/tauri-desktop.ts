import { getCurrentWebview } from '@tauri-apps/api/webview';
import { readFile } from '@tauri-apps/plugin-fs';
import { createFsPackStore } from './packs-fs';
import type { PickedFile, PlatformAdapter } from './types';
import { checkInPlaceUpdate, restartApp } from './updater';
import { baseName, openExternal, pickApkWithDialog, pickPackWithDialog, saveWithDialog, updateTarget } from './tauri-common';

/** Windows/Linux/macOS Tauri shell: native dialogs + scoped fs. No Android-only capabilities. */
export function createTauriDesktopAdapter(): PlatformAdapter {
  return {
    kind: 'tauri-desktop',
    openUrl: openExternal,
    updateTarget,
    checkInPlaceUpdate,
    restart: restartApp,
    pickApk: pickApkWithDialog,
    saveOutput: saveWithDialog,
    packStore: createFsPackStore(),
    pickPack: () => pickPackWithDialog(),
    onFileDrop: (cb) => getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      if (payload.type !== 'drop') return;
      const files: PickedFile[] = await Promise.all(payload.paths.map(async (p) => ({ name: baseName(p), bytes: await readFile(p) })));
      cb(files);
    })
  };
}
