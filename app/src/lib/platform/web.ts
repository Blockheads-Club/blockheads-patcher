import { IndexedDbPackStore } from './packs-idb';
import type { PickedApk, PickedFile, PlatformAdapter } from './types';

export async function fileToPicked(file: File): Promise<PickedApk> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), source: 'file' };
}

/** Trigger a browser download using a blob URL. */
export function downloadBlob(name: string, bytes: Uint8Array, mime = 'application/vnd.android.package-archive'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{
    name: string;
    createWritable(): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }>;
  }>;
}

/** Opens the browser's file picker; resolves with the chosen file or null. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function createWebPlatform(): PlatformAdapter {
  return {
    kind: 'web',
    async openUrl(url: string): Promise<void> {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    packStore: new IndexedDbPackStore(),
    async pickPack(): Promise<PickedFile | null> {
      const f = await pickFile('.bhpack,.zip,application/zip');
      return f && { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    },
    pickApk() {
      return new Promise<PickedApk | null>((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.apk,application/vnd.android.package-archive';
        input.onchange = () => {
          const f = input.files?.[0];
          if (!f) return resolve(null);
          fileToPicked(f).then(resolve, reject);
        };
        input.oncancel = () => resolve(null);
        input.click();
      });
    },
    async saveOutput(name, bytes) {
      const w = window as unknown as SaveFilePickerWindow;
      if (typeof w.showSaveFilePicker === 'function') {
        try {
          const handle = await w.showSaveFilePicker({ suggestedName: name });
          const writable = await handle.createWritable();
          await writable.write(bytes as BlobPart);
          await writable.close();
          return { location: handle.name };
        } catch (e) {
          if ((e as DOMException)?.name === 'AbortError') return {};
          // fall through to a plain download
        }
      }
      downloadBlob(name, bytes);
      return {};
    }
  };
}
