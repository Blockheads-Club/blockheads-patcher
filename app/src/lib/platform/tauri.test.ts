import { beforeEach, describe, expect, it, vi } from 'vitest';

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
const fs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  open: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn()
}));
const plugin = vi.hoisted(() => ({
  getInstalledPackage: vi.fn(),
  readInstalledApk: vi.fn(),
  requestUninstall: vi.fn(),
  installApk: vi.fn(),
  canRequestInstalls: vi.fn(),
  openInstallSettings: vi.fn(),
  updateDownload: vi.fn(),
  updateStatus: vi.fn(),
  updateCancel: vi.fn()
}));

vi.mock('@tauri-apps/plugin-dialog', () => dialog);
vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('@tauri-apps/api/path', () => ({
  appCacheDir: async () => '/cache',
  join: async (...p: string[]) => p.join('/')
}));
vi.mock('@bh-patcher/tauri-plugin-apk-tools-api', () => plugin);
const native = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}), invoke: vi.fn(async () => ({ os: 'windows', arch: 'x86_64', appimage: false })) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: native.openUrl }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import { createTauriDesktopAdapter } from './tauri-desktop';
import { createTauriAndroidAdapter } from './tauri-android';
import { baseName, safeFileName, filterFor, WRITE_CHUNK } from './tauri-common';
import { setLanguage } from '../i18n';

beforeEach(() => {
  vi.clearAllMocks();
  fs.remove.mockResolvedValue(undefined);
});

describe('helpers', () => {
  it('baseName falls back for empty paths', () => { expect(baseName('')).toBe('game.apk'); expect(baseName('///')).toBe('game.apk'); });
  it('baseName handles paths and content URIs', () => {
    expect(baseName('/a/b/game.apk')).toBe('game.apk');
    expect(baseName('C:\\x\\game.apk')).toBe('game.apk');
    expect(baseName('content://x/document/primary%3ADownload%2Fgame.apk')).toBe('game.apk');
  });
  it('baseName keeps a malformed escape raw', () => { expect(baseName('/a/100%/g.apk')).toBe('g.apk'); });
  it('pickApkWithDialog handles array selections', async () => {
    const { pickApkWithDialog } = await import('./tauri-common');
    dialog.open.mockResolvedValueOnce(['/x/y.apk']);
    fs.readFile.mockResolvedValueOnce(new Uint8Array([1]));
    expect((await pickApkWithDialog())!.name).toBe('y.apk');
  });
  it('safeFileName strips separators', () => {
    expect(safeFileName('../a b/c.apk')).toBe('_a_b_c.apk');
    expect(safeFileName('...')).toBe('patched.apk');
  });
});

describe('save filter and chunked writes', () => {
  it('derives the dialog filter from the extension', async () => {
    expect(filterFor('k.json')[0]!.extensions).toEqual(['json']);
    expect(filterFor('p.apk')[0]!.extensions).toEqual(['apk']);
    expect(filterFor('p.apk')[0]!.name).toBe('Android package');
    setLanguage('ru');
    try { expect(filterFor('p.apk')[0]!.name).toBe('Пакет Android'); } finally { setLanguage('en'); }
    const a = createTauriDesktopAdapter();
    dialog.save.mockResolvedValueOnce('/out/k.json');
    await a.saveOutput('blockheads-patcher-key.json', new Uint8Array([1]));
    expect(dialog.save).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: 'JSON', extensions: ['json'] }] }));
  });
  it('never sends more than WRITE_CHUNK bytes per IPC call for large outputs', async () => {
    const written: number[] = [];
    const handle = { write: vi.fn(async (b: Uint8Array) => { written.push(b.length); return b.length; }), close: vi.fn(async () => {}) };
    fs.open.mockResolvedValue(handle);
    const a = createTauriAndroidAdapter();
    plugin.installApk.mockResolvedValueOnce({ started: true });
    const total = WRITE_CHUNK * 2 + 123;
    await a.installApk!('big.apk', new Uint8Array(total));
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(Math.max(...written)).toBeLessThanOrEqual(WRITE_CHUNK);
    expect(written.reduce((x, y) => x + y, 0)).toBe(total);
    expect(handle.close).toHaveBeenCalled();
  });
  it('closes the handle and rejects on a short write', async () => {
    const handle = { write: vi.fn(async () => 0), close: vi.fn(async () => {}) };
    fs.open.mockResolvedValue(handle);
    const a = createTauriAndroidAdapter();
    await expect(a.installApk!('big.apk', new Uint8Array(WRITE_CHUNK + 1))).rejects.toThrow(/short write/);
    expect(handle.close).toHaveBeenCalled();
  });
  it('refuses to load an installed game that has split APKs', async () => {
    const a = createTauriAndroidAdapter();
    plugin.readInstalledApk.mockResolvedValueOnce({ path: '/cache/bhp/x.apk', size: 1, splitSourceDirs: ['/data/app/split_config.apk'] });
    await expect(a.loadInstalledApk!()).rejects.toThrow(/unsupported/);
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});

describe('updates', () => {
  it('both shells open pages in the system browser and ask Rust for the build target', async () => {
    for (const a of [createTauriDesktopAdapter(), createTauriAndroidAdapter()]) {
      await a.openUrl!('https://blockheads.club/');
      expect(native.openUrl).toHaveBeenLastCalledWith('https://blockheads.club/');
      expect(await a.updateTarget!()).toEqual({ os: 'windows', arch: 'x86_64', appimage: false });
      expect(native.invoke).toHaveBeenLastCalledWith('update_target');
    }
  });
});

describe('desktop adapter', () => {
  it('has no android capabilities', () => {
    const a = createTauriDesktopAdapter();
    expect(a.kind).toBe('tauri-desktop');
    expect(a.installApk).toBeUndefined();
    expect(a.getInstalledGame).toBeUndefined();
  });
  it('pickApk returns null on cancel and bytes on pick', async () => {
    const a = createTauriDesktopAdapter();
    dialog.open.mockResolvedValueOnce(null);
    expect(await a.pickApk()).toBeNull();
    dialog.open.mockResolvedValueOnce('/home/u/The Blockheads.apk');
    fs.readFile.mockResolvedValueOnce(new Uint8Array([1, 2]));
    const p = await a.pickApk();
    expect(p).toEqual({ name: 'The Blockheads.apk', bytes: new Uint8Array([1, 2]), source: 'file' });
  });
  it('saveOutput writes to the chosen path', async () => {
    const a = createTauriDesktopAdapter();
    dialog.save.mockResolvedValueOnce('/out/p.apk');
    const r = await a.saveOutput('p.apk', new Uint8Array([9]));
    expect(fs.writeFile).toHaveBeenCalledWith('/out/p.apk', new Uint8Array([9]));
    expect(r.location).toBe('/out/p.apk');
    dialog.save.mockResolvedValueOnce(null);
    expect(await a.saveOutput('p.apk', new Uint8Array())).toEqual({});
  });
});

describe('android adapter', () => {
  it('reports installed game info', async () => {
    const a = createTauriAndroidAdapter();
    plugin.getInstalledPackage.mockResolvedValueOnce({ installed: false });
    expect(await a.getInstalledGame!()).toBeNull();
    plugin.getInstalledPackage.mockResolvedValueOnce({
      installed: true, packageName: 'com.noodlecake.blockheads', versionName: '1.7.4',
      versionCode: 1548230154, sourceDir: '/data/app/x/base.apk', splitSourceDirs: []
    });
    expect(await a.getInstalledGame!()).toMatchObject({ versionName: '1.7.4', versionCode: 1548230154 });
  });
  it('loadInstalledApk reads the cache copy then deletes it', async () => {
    const a = createTauriAndroidAdapter();
    plugin.readInstalledApk.mockResolvedValueOnce({ path: '/cache/bhp/x-base.apk', size: 3, splitSourceDirs: [] });
    fs.readFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    const p = await a.loadInstalledApk!();
    expect(p.source).toBe('installed');
    expect(p.bytes.length).toBe(3);
    expect(fs.remove).toHaveBeenCalledWith('/cache/bhp/x-base.apk');
  });
  it('installApk writes into cache/bhp and passes the path', async () => {
    const a = createTauriAndroidAdapter();
    plugin.installApk.mockResolvedValueOnce({ started: true });
    const r = await a.installApk!('../evil name.apk', new Uint8Array([1]));
    expect(fs.writeFile).toHaveBeenCalledWith('/cache/bhp/_evil_name.apk', new Uint8Array([1]));
    expect(plugin.installApk).toHaveBeenCalledWith('/cache/bhp/_evil_name.apk');
    expect(r.started).toBe(true);
  });
  it('uninstall and install-permission helpers delegate', async () => {
    const a = createTauriAndroidAdapter();
    plugin.requestUninstall.mockResolvedValueOnce({ started: true, completed: false });
    expect(await a.uninstallOriginal!()).toEqual({ started: true, completed: false });
    plugin.canRequestInstalls.mockResolvedValueOnce({ allowed: false });
    expect(await a.canRequestInstalls!()).toBe(false);
    plugin.openInstallSettings.mockResolvedValueOnce(undefined);
    await a.openInstallSettings!();
    expect(plugin.openInstallSettings).toHaveBeenCalled();
  });
  describe('app update (APK download + system installer)', () => {
    const file = { name: 'blockheads-patcher-0.4.0-android-arm64.apk', url: 'https://github.com/x/dl', size: 100, sumsUrl: 'https://github.com/x/sums' };
    const status = (over = {}) => ({ state: 'running', received: 0, total: 0, path: '', error: '', ...over });

    it('downloads natively, polls the progress, then installs the verified file', async () => {
      vi.useFakeTimers();
      try {
        const a = createTauriAndroidAdapter();
        const h = a.openAppUpdate!(file, '0.4.0');
        expect(h.version).toBe('0.4.0');
        plugin.updateStatus
          .mockResolvedValueOnce(status({ received: 10, total: 100 }))
          .mockResolvedValueOnce(status({ received: 5 }))
          .mockResolvedValueOnce(status({ state: 'done', received: 100, total: 100, path: '/cache/bhp/updates/a.apk' }));
        const seen: unknown[] = [];
        const done = h.download((p) => seen.push(p));
        await vi.advanceTimersByTimeAsync(1000);
        await done;
        expect(plugin.updateDownload).toHaveBeenCalledWith(file.url, file.name, 100, file.sumsUrl);
        expect(seen).toEqual([{ done: 10, total: 100 }, { done: 5, total: null }, { done: 100, total: 100 }]);
        plugin.canRequestInstalls.mockResolvedValueOnce({ allowed: true });
        plugin.installApk.mockResolvedValueOnce({ started: true });
        await h.install();
        expect(plugin.installApk).toHaveBeenCalledWith('/cache/bhp/updates/a.apk');
        await h.close();
        expect(plugin.updateCancel).toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
    it('a failed or cancelled download rejects', async () => {
      vi.useFakeTimers();
      try {
        const a = createTauriAndroidAdapter();
        plugin.updateStatus.mockResolvedValueOnce(status({ state: 'error', error: 'checksum mismatch' }));
        const failed = expect(a.openAppUpdate!(file, '0.4.0').download(() => {})).rejects.toThrow('checksum mismatch');
        await vi.advanceTimersByTimeAsync(300);
        await failed;
        plugin.updateStatus.mockResolvedValueOnce(status({ state: 'idle' }));
        const cancelled = expect(a.openAppUpdate!(file, '0.4.0').download(() => {})).rejects.toThrow(/cancelled/);
        await vi.advanceTimersByTimeAsync(300);
        await cancelled;
      } finally { vi.useRealTimers(); }
    });
    it('without the "install unknown apps" permission it opens that screen and rejects', async () => {
      const a = createTauriAndroidAdapter();
      plugin.canRequestInstalls.mockResolvedValueOnce({ allowed: false });
      await expect(a.openAppUpdate!(file, '0.4.0').install()).rejects.toThrow('permission_denied');
      expect(plugin.openInstallSettings).toHaveBeenCalled();
      expect(plugin.installApk).not.toHaveBeenCalled();
    });
  });
  it('saveOutput falls back to the cache when the dialog throws', async () => {
    const a = createTauriAndroidAdapter();
    dialog.save.mockRejectedValueOnce(new Error('no dialog'));
    const r = await a.saveOutput('p.apk', new Uint8Array([1]));
    expect(r.location).toBe('/cache/bhp/p.apk');
  });
});
