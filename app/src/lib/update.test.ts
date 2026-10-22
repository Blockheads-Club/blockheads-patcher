import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Release } from '@bh-patcher/core';
import { DAY_MS, RELEASES_URL, UpdateState, createUpdateState, releasePage, type UpdateDeps } from './update.svelte';
import { mockPlatform } from './testing';

const asset = (name: string, size = 5_000_000) => ({ name, size, browser_download_url: `https://github.com/dl/${name}` });
const rel = (tag: string, over: Partial<Release> = {}): Release => ({
  tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/rel/${tag}`, body: '## What’s new\n- **Faster** patching\n- Fixes',
  assets: [asset(`Blockheads.Patcher_${tag.slice(1)}_x64-setup.exe`), asset(`blockheads-patcher-${tag.slice(1)}-android-arm64.apk`)], ...over
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const releases = (...list: Release[]) => vi.fn(async () => json(list));

function make(over: Partial<UpdateDeps> = {}, t = 1_000_000_000_000) {
  const deps: UpdateDeps = {
    kind: 'tauri-desktop', current: '0.1.1', fetch: releases(rel('v0.2.0')) as never, openUrl: vi.fn(async () => {}),
    reload: vi.fn(), target: vi.fn(async () => ({ os: 'windows' as const, arch: 'x86_64' })), now: () => t, ...over
  };
  return { u: new UpdateState(deps), deps };
}

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('preferences', () => {
  test('defaults, persisted and reloaded', () => {
    const { u } = make();
    expect([u.autoCheck, u.channel, u.lastChecked, u.lastSuccess, u.stage, u.web, u.kind, u.current]).toEqual([true, 'stable', 0, 0, 'idle', false, 'tauri-desktop', '0.1.1']);
    u.setAutoCheck(false);
    u.setChannel('beta');
    const again = make().u;
    expect([again.autoCheck, again.channel]).toEqual([false, 'beta']);
    again.setAutoCheck(true);
    expect(make().u.autoCheck).toBe(true);
  });
  test('storage that throws: defaults, writes ignored', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { u } = make();
    expect(u.autoCheck).toBe(true);
    u.setAutoCheck(false);
    expect(u.autoCheck).toBe(false);
  });
  test('changing the channel cancels a running check and forgets the result', async () => {
    const { u } = make();
    await u.check();
    expect(u.info).not.toBeNull();
    u.setChannel('stable'); // unchanged: nothing happens
    expect(u.info).not.toBeNull();
    const pending = u.check({ popup: true });
    u.setChannel('beta');
    await pending;
    expect([u.stage, u.info, u.open]).toEqual(['idle', null, false]);
  });
});

describe('native check (GitHub releases)', () => {
  test('a newer release: notes, matching download, persisted times, pending popup once per version', async () => {
    const { u, deps } = make();
    await u.check();
    expect(u.stage).toBe('available');
    expect(u.info).toEqual({
      version: '0.2.0', notes: ['Faster patching', 'Fixes'], page: 'https://github.com/rel/v0.2.0',
      download: { name: 'Blockheads.Patcher_0.2.0_x64-setup.exe', url: 'https://github.com/dl/Blockheads.Patcher_0.2.0_x64-setup.exe', size: 5_000_000 }
    });
    expect([u.lastChecked, u.lastSuccess, u.pending, u.open]).toEqual([1_000_000_000_000, 1_000_000_000_000, true, false]);
    expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('/releases?per_page=20');
    u.show();
    expect([u.open, u.pending]).toEqual([true, false]);
    u.hide();
    const next = make().u;
    expect(next.lastChecked).toBe(1_000_000_000_000);
    await next.check();
    expect(next.pending).toBe(false); // already shown
  });
  test('beta channel offers pre-releases', async () => {
    const { u } = make({ fetch: releases(rel('v0.1.2'), rel('v0.3.0-rc.1', { prerelease: true })) as never });
    await u.check();
    expect(u.info?.version).toBe('0.1.2');
    u.setChannel('beta');
    await u.check();
    expect(u.info?.version).toBe('0.3.0-rc.1');
  });
  test('up to date: same version or no release at all', async () => {
    const { u } = make({ fetch: releases(rel('v0.1.1')) as never });
    await u.check({});
    expect([u.stage, u.info, u.open]).toEqual(['uptodate', null, false]);
    const empty = make({ fetch: releases() as never }).u;
    await empty.check();
    expect(empty.stage).toBe('uptodate');
  });
  test('no matching file: no download (target unknown, failing or unmatched)', async () => {
    for (const target of [undefined, vi.fn(async () => { throw new Error('no ipc'); }), vi.fn(async () => ({ os: 'linux' as const, arch: 'x86_64' }))]) {
      const { u } = make({ target });
      await u.check();
      expect(u.info?.download).toBeUndefined();
    }
  });
  test('a failed check keeps the last success time and reports the error', async () => {
    localStorage.setItem('bhp.upd.ok', '5');
    const { u } = make({ fetch: vi.fn(async () => json({}, 403)) as never });
    await u.check();
    expect([u.stage, u.error, u.lastSuccess, u.lastChecked]).toEqual(['error', 'GitHub releases: HTTP 403', 5, 1_000_000_000_000]);
    const thrown = make({ fetch: vi.fn(async () => { throw 'offline'; }) as never }).u;
    await thrown.check();
    expect(thrown.error).toBe('offline');
  });
  test('the global fetch and clock are the defaults', async () => {
    vi.stubGlobal('fetch', releases(rel('v0.2.0')));
    const u = new UpdateState({ kind: 'tauri-android', current: '0.1.1', openUrl: async () => {} });
    await u.check();
    expect(u.stage).toBe('available');
    expect(u.lastChecked).toBeGreaterThan(0);
  });
});

describe('web check (deployed version)', () => {
  const web = (fetcher: (url: string) => Promise<Response>) => make({ kind: 'web', base: '/patcher', fetch: vi.fn(fetcher) as never, target: undefined });
  test('newer version.json: reload offer, release page link, no notes', async () => {
    const { u, deps } = web(async () => new Response('{"version":"0.2.0"}'));
    await u.check();
    expect(u.info).toEqual({ version: '0.2.0', notes: [], page: releasePage('0.2.0') });
    expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['/patcher/version.json?t=1000000000000', expect.objectContaining({ cache: 'no-store' })]);
  });
  test('falls back to the website’s patcher-version.txt; same version is up to date', async () => {
    const { u } = web(async (url) => (url.includes('version.json') ? new Response('<html>', { status: 404 }) : new Response('v0.1.1 abc\n')));
    await u.check();
    expect(u.stage).toBe('uptodate');
    const html = web(async (url) => new Response(url.includes('version.json') ? '<!doctype html>' : 'v0.2.0 abc'));
    await html.u.check();
    expect(html.u.info?.version).toBe('0.2.0');
  });
  test('no version anywhere, or offline: error', async () => {
    const { u } = web(async () => new Response('nope', { status: 404 }));
    await u.check();
    expect([u.stage, u.error]).toEqual(['error', 'the deployed version is unknown']);
    const off = web(async () => { throw new TypeError('Failed to fetch'); });
    await off.u.check();
    expect(off.u.error).toBe('Failed to fetch');
  });
  test('default base path is the site root', async () => {
    const fetcher = vi.fn(async () => new Response('{"version":"0.1.1"}'));
    const u = new UpdateState({ kind: 'web', current: '0.1.1', fetch: fetcher as never, openUrl: async () => {}, now: () => 7 });
    await u.check();
    expect((fetcher.mock.calls[0] as unknown[])[0]).toBe('/version.json?t=7');
  });
  test('install reloads the page', async () => {
    const { u, deps } = web(async () => new Response('{"version":"0.2.0"}'));
    await u.check();
    await u.install();
    expect(deps.reload).toHaveBeenCalled();
    const noReload = new UpdateState({ kind: 'web', current: '0.1.1', fetch: vi.fn(async () => new Response('{"version":"0.2.0"}')) as never, openUrl: async () => {} });
    await noReload.check();
    await noReload.install(); // no reload seam: nothing to do
  });
});

describe('automatic check', () => {
  test('off: never checks', () => {
    localStorage.setItem('bhp.upd.auto', '0');
    const { u, deps } = make();
    u.autoStart();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  test('at most once a day, unless a newer version is already known', async () => {
    const t = 1_000_000_000_000;
    localStorage.setItem('bhp.upd.checked', String(t - DAY_MS + 1));
    const recent = make({}, t);
    recent.u.autoStart();
    expect(recent.deps.fetch).not.toHaveBeenCalled();
    localStorage.setItem('bhp.upd.latest', '0.1.1');
    make({}, t).u.autoStart();
    localStorage.setItem('bhp.upd.latest', '0.2.0');
    const known = make({}, t);
    known.u.autoStart();
    expect(known.deps.fetch).toHaveBeenCalled();
    localStorage.removeItem('bhp.upd.latest');
    const due = make({}, t + 1);
    due.u.autoStart();
    expect(due.deps.fetch).toHaveBeenCalled();
  });
});

describe('popup actions', () => {
  test('the icon checks when there is nothing to show, else opens the popup', async () => {
    const { u, deps } = make({ fetch: releases(rel('v0.1.1')) as never });
    u.show();
    expect([u.stage, u.open]).toEqual(['checking', true]);
    await vi.waitFor(() => expect(u.stage).toBe('uptodate'));
    u.hide();
    u.show(); // up to date: checks again
    await vi.waitFor(() => expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2));
    const failed = make({ fetch: vi.fn(async () => json({}, 500)) as never }).u;
    await failed.check();
    failed.show();
    expect([failed.stage, failed.open]).toEqual(['error', true]);
  });
  test('cancel stops a running check; late results of a superseded check are dropped', async () => {
    let release!: (r: Response) => void;
    const slow = vi.fn(() => new Promise<Response>((r) => { release = r; }));
    const { u } = make({ fetch: slow as never });
    u.cancel(); // nothing running
    const first = u.check({ popup: true });
    u.cancel();
    expect([u.stage, u.open]).toEqual(['idle', false]);
    release(json([rel('v0.2.0')]));
    await first;
    expect(u.stage).toBe('idle');

    let fail!: (e: unknown) => void;
    const failing = vi.fn(() => new Promise<Response>((_, rej) => { fail = rej; }));
    const second = make({ fetch: failing as never }).u;
    const p = second.check();
    second.cancel();
    fail(new Error('aborted'));
    await p;
    expect(second.stage).toBe('idle');
  });
  test('a new check replaces a running one', async () => {
    const { u, deps } = make();
    const a = u.check();
    const b = u.check({ popup: true });
    await Promise.all([a, b]);
    expect([u.stage, u.open, (deps.fetch as ReturnType<typeof vi.fn>).mock.calls.length]).toEqual(['available', true, 2]);
  });
  test('install hands the installer (or the release page) to the system', async () => {
    const { u, deps } = make();
    await u.install(); // nothing found yet
    expect(deps.openUrl).not.toHaveBeenCalled();
    await u.check();
    await u.install();
    expect(deps.openUrl).toHaveBeenCalledWith('https://github.com/dl/Blockheads.Patcher_0.2.0_x64-setup.exe');
    expect(u.handedOff).toBe(true);
    await u.check();
    expect(u.handedOff).toBe(false);

    const page = make({ target: undefined });
    await page.u.check();
    await page.u.install();
    expect(page.deps.openUrl).toHaveBeenCalledWith('https://github.com/rel/v0.2.0');

    const broken = make({ openUrl: vi.fn(async () => { throw new Error('no browser'); }) });
    await broken.u.check();
    await broken.u.install();
    expect([broken.u.stage, broken.u.error, broken.u.handedOff]).toEqual(['error', 'no browser', false]);
  });
  test('release page: the found release, else the latest; failures are ignored', async () => {
    const { u, deps } = make();
    u.openPage();
    expect(deps.openUrl).toHaveBeenLastCalledWith(RELEASES_URL);
    await u.check();
    u.openPage();
    expect(deps.openUrl).toHaveBeenLastCalledWith('https://github.com/rel/v0.2.0');
    const broken = make({ openUrl: vi.fn(async () => { throw new Error('x'); }) }).u;
    broken.openPage();
    await Promise.resolve();
  });
});

describe('createUpdateState', () => {
  test('wires the platform', async () => {
    const openUrl = vi.fn(async () => {});
    const updateTarget = vi.fn(async () => ({ os: 'android' as const, arch: 'aarch64' }));
    const u = createUpdateState(mockPlatform({ kind: 'tauri-android', openUrl, updateTarget }), '0.0.1');
    expect([u.kind, u.current]).toEqual(['tauri-android', '0.0.1']);
    u.openPage();
    expect(openUrl).toHaveBeenCalledWith(RELEASES_URL);
    vi.stubGlobal('fetch', releases(rel('v0.2.0')));
    await u.check();
    expect(updateTarget).toHaveBeenCalled();
    expect(u.info?.download?.name).toBe('blockheads-patcher-0.2.0-android-arm64.apk');
  });
  test('web: app version, reload through location, platform without openUrl', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"version":"99.0.0"}')));
    const u = createUpdateState(mockPlatform());
    expect(u.current).toBe(__APP_VERSION__);
    u.openPage();
    await u.check();
    await u.install();
    expect(reload).toHaveBeenCalled();
  });
});
