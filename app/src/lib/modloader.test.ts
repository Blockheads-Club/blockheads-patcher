import { describe, expect, test, vi } from 'vitest';
import { MOD_LOADER_PIN } from '@bh-patcher/core';
import { fetchModLoader, modLoaderError } from './modloader';
import { classifyError } from './errors';

const sha = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');
const resp = (body: Uint8Array, status = 200) => ({ ok: status === 200, status, arrayBuffer: async () => body.slice().buffer }) as unknown as Response;

describe('fetchModLoader', () => {
  test('reads the pinned file next to the app and checks it', async () => {
    const body = new Uint8Array([1, 2, 3]);
    const pin = { ...MOD_LOADER_PIN, size: 3, sha256: await sha(body) };
    const f = vi.fn(async () => resp(body));
    expect(await fetchModLoader(f as never, '/base', pin)).toEqual(body);
    expect(f).toHaveBeenCalledWith(`/base/mod-loader/bhmod-android-loader-${pin.version}.zip`);
    await expect(fetchModLoader(f as never, '', { ...pin, sha256: '0'.repeat(64) })).rejects.toThrow(/does not match/);
    await expect(fetchModLoader(f as never, '', { ...pin, size: 4 })).rejects.toThrow(/does not match/);
    await expect(fetchModLoader((async () => resp(body, 404)) as never, '', pin)).rejects.toThrow(/HTTP 404/);
    await expect(fetchModLoader((async () => { throw new Error('offline'); }) as never, '', pin)).rejects.toThrow(/offline/);
    await expect(fetchModLoader((async () => { throw 'x'; }) as never, '', pin)).rejects.toThrow(/\(x\)/); // eslint-disable-line no-throw-literal
  });
  test('errors are translated as modLoaderUnavailable; the default uses global fetch', async () => {
    expect(classifyError(modLoaderError('m'))).toEqual({ code: 'modLoaderUnavailable', params: { message: 'm' } });
    const g = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp(new Uint8Array(), 404));
    await expect(fetchModLoader()).rejects.toThrow(/HTTP 404/);
    g.mockRestore();
  });
});
