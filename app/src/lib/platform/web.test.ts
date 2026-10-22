import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWebPlatform, downloadBlob } from './web';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete (window as never as Record<string, unknown>).showSaveFilePicker; });

function stubUrl() {
  (URL as never as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:x');
  (URL as never as Record<string, unknown>).revokeObjectURL = vi.fn();
}

describe('web platform', () => {
  test('openUrl opens a new tab without opener access', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await createWebPlatform().openUrl!('https://blockheads.club/');
    expect(open).toHaveBeenCalledWith('https://blockheads.club/', '_blank', 'noopener,noreferrer');
  });
  test('downloadBlob clicks an anchor and revokes later', () => {
    vi.useFakeTimers();
    stubUrl();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadBlob('a.apk', new Uint8Array([1]));
    downloadBlob('a.json', new Uint8Array([1]), 'application/json');
    expect(click).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  test('saveOutput uses showSaveFilePicker when available', async () => {
    const write = vi.fn(async () => {}); const close = vi.fn(async () => {});
    (window as never as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => ({ name: 'picked.apk', createWritable: async () => ({ write, close }) }));
    expect(await createWebPlatform().saveOutput('a.apk', new Uint8Array([1]))).toEqual({ location: 'picked.apk' });
    expect(write).toHaveBeenCalled();
  });

  test('saveOutput: abort returns empty, other errors fall back to download, no picker downloads', async () => {
    stubUrl();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const w = window as never as Record<string, unknown>;
    w.showSaveFilePicker = vi.fn(async () => { throw new DOMException('x', 'AbortError'); });
    expect(await createWebPlatform().saveOutput('a', new Uint8Array())).toEqual({});
    expect(click).not.toHaveBeenCalled();
    w.showSaveFilePicker = vi.fn(async () => { throw new Error('boom'); });
    expect(await createWebPlatform().saveOutput('a', new Uint8Array())).toEqual({});
    w.showSaveFilePicker = vi.fn(async () => { throw null; });
    expect(await createWebPlatform().saveOutput('a', new Uint8Array())).toEqual({});
    delete w.showSaveFilePicker;
    expect(await createWebPlatform().saveOutput('a', new Uint8Array())).toEqual({});
    expect(click).toHaveBeenCalledTimes(3);
  });

  describe('pickApk', () => {
    function capture() {
      let input!: HTMLInputElement;
      vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { input = this; });
      return () => input;
    }
    test('resolves picked file', async () => {
      const get = capture();
      const p = createWebPlatform().pickApk();
      Object.defineProperty(get(), 'files', { value: [new File([new Uint8Array([1])], 'g.apk')] });
      get().onchange!(new Event('change'));
      expect(await p).toMatchObject({ name: 'g.apk', source: 'file' });
    });
    test('resolves null with no file', async () => {
      const get = capture();
      const p = createWebPlatform().pickApk();
      get().onchange!(new Event('change'));
      expect(await p).toBeNull();
    });
    test('resolves null on cancel', async () => {
      const get = capture();
      const p = createWebPlatform().pickApk();
      (get() as never as { oncancel(): void }).oncancel();
      expect(await p).toBeNull();
    });
    test('rejects when reading fails', async () => {
      const get = capture();
      const p = createWebPlatform().pickApk();
      const f = new File([new Uint8Array([1])], 'g.apk');
      vi.spyOn(f, 'arrayBuffer').mockRejectedValue(new Error('read'));
      Object.defineProperty(get(), 'files', { value: [f] });
      get().onchange!(new Event('change'));
      await expect(p).rejects.toThrow('read');
    });
  });
});
