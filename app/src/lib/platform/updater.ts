// Desktop seam to the Tauri updater plugin and the app's restart command (mocked in tests).
import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import type { InPlaceUpdate } from './types';

/** The update the updater endpoint offers, or null when this build is the newest one there. */
export async function checkInPlaceUpdate(): Promise<InPlaceUpdate | null> {
  const u = await check();
  if (!u) return null;
  return {
    version: u.version,
    async download(onProgress) {
      let done = 0;
      let total: number | null = null;
      await u.download((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? null;
        else if (e.event === 'Progress') done += e.data.chunkLength;
        onProgress({ done, total });
      });
    },
    install: () => u.install(),
    close: () => u.close()
  };
}

export async function restartApp(): Promise<void> {
  await invoke('app_restart');
}
