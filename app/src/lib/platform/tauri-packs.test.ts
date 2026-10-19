import { beforeEach, describe, expect, it, vi } from 'vitest';

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
const fs = vi.hoisted(() => ({
  readFile: vi.fn(), writeFile: vi.fn(), open: vi.fn(), mkdir: vi.fn(), remove: vi.fn(), readDir: vi.fn(), exists: vi.fn()
}));
const webview = vi.hoisted(() => ({ handler: null as null | ((e: { payload: unknown }) => Promise<void>), unlisten: vi.fn() }));

vi.mock('@tauri-apps/plugin-dialog', () => dialog);
vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('@tauri-apps/api/path', () => ({ appCacheDir: async () => '/cache', appDataDir: async () => '/data', join: async (...p: string[]) => p.join('/') }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async (h: typeof webview.handler) => { webview.handler = h; return webview.unlisten; } })
}));
vi.mock('@bh-patcher/tauri-plugin-apk-tools-api', () => ({}));

import { createFsPackStore } from './packs-fs';
import { pickPackWithDialog } from './tauri-common';
import { createTauriDesktopAdapter } from './tauri-desktop';
import { createTauriAndroidAdapter } from './tauri-android';

beforeEach(() => { vi.clearAllMocks(); });

describe('file-system pack store', () => {
  it('lists <app data>/packs/*.bhpack sorted, skipping anything else', async () => {
    fs.readDir.mockResolvedValueOnce([
      { name: 'b.bhpack', isFile: true }, { name: 'a.bhpack', isFile: true }, { name: 'dir.bhpack', isFile: false },
      { name: 'notes.txt', isFile: true }, { name: '.x.bhpack', isFile: true }
    ]);
    fs.readFile.mockImplementation(async (p: string) => new TextEncoder().encode(p));
    const rows = await createFsPackStore().list();
    expect(fs.mkdir).toHaveBeenCalledWith('/data/packs', { recursive: true });
    expect(rows.map((r) => [r.id, new TextDecoder().decode(r.bytes)])).toEqual([['a', '/data/packs/a.bhpack'], ['b', '/data/packs/b.bhpack']]);
  });

  it('writes and removes by id and refuses unsafe ids', async () => {
    const s = createFsPackStore();
    await s.put('demo', new Uint8Array([1]));
    expect(fs.writeFile).toHaveBeenCalledWith('/data/packs/demo.bhpack', new Uint8Array([1]));
    fs.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await s.remove('demo');
    await s.remove('gone');
    expect(fs.remove).toHaveBeenCalledTimes(1);
    await expect(s.put('../x', new Uint8Array())).rejects.toThrow(/invalid pack id/);
  });
});

describe('pack pickers and drops', () => {
  it('picks with or without the extension filter', async () => {
    dialog.open.mockResolvedValueOnce('/x/my.bhpack').mockResolvedValueOnce(['/y/other.zip']).mockResolvedValueOnce(null);
    fs.readFile.mockResolvedValue(new Uint8Array([7]));
    expect(await pickPackWithDialog()).toEqual({ name: 'my.bhpack', bytes: new Uint8Array([7]) });
    expect(dialog.open.mock.calls[0]![0].filters[0].extensions).toEqual(['bhpack', 'zip']);
    expect(await pickPackWithDialog(false)).toEqual({ name: 'other.zip', bytes: new Uint8Array([7]) });
    expect(dialog.open.mock.calls[1]![0].filters).toBeUndefined();
    expect(await pickPackWithDialog()).toBeNull();
  });

  it('desktop reports dropped files; Android picks without a filter', async () => {
    const d = createTauriDesktopAdapter();
    expect(d.packStore).toBeTruthy();
    const cb = vi.fn();
    expect(await d.onFileDrop!(cb)).toBe(webview.unlisten);
    fs.readFile.mockResolvedValue(new Uint8Array([3]));
    await webview.handler!({ payload: { type: 'enter', paths: ['/a.bhpack'] } });
    expect(cb).not.toHaveBeenCalled();
    await webview.handler!({ payload: { type: 'drop', paths: ['/p/a.bhpack'] } });
    expect(cb).toHaveBeenCalledWith([{ name: 'a.bhpack', bytes: new Uint8Array([3]) }]);
    dialog.open.mockResolvedValue('/z.bhpack');
    await d.pickPack!();
    expect(dialog.open.mock.calls.at(-1)![0].filters).toBeDefined();

    const a = createTauriAndroidAdapter();
    expect(a.packStore).toBeTruthy();
    await a.pickPack!();
    expect(dialog.open.mock.calls.at(-1)![0].filters).toBeUndefined();
  });
});
