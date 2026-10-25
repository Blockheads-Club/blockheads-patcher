import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Release } from '@bh-patcher/core';
import { DAY_MS, RELEASES_URL, UpdateState, createUpdateState, releasePage, type UpdateDeps } from './update.svelte';
import { mockPlatform } from './testing';
import { INSTALL_NOT_ALLOWED, type InPlaceUpdate } from './platform/types';

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
      download: { name: 'Blockheads.Patcher_0.2.0_x64-setup.exe', url: 'https://github.com/dl/Blockheads.Patcher_0.2.0_x64-setup.exe', size: 5_000_000 },
      inPlace: false
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

describe('Android in-app update', () => {
  const sums = asset('SHA256SUMS.txt', 300);
  const apkRel = (over: Partial<Release> = {}) => rel('v0.2.0', { assets: [...rel('v0.2.0').assets, sums], ...over });
  const handle = (over: Partial<InPlaceUpdate> = {}) => ({
    version: '0.2.0', download: vi.fn(async (cb: (p: { done: number; total: number | null }) => void) => { cb({ done: 1, total: 2 }); }),
    install: vi.fn(async () => {}), close: vi.fn(async () => {}), ...over
  }) satisfies InPlaceUpdate;
  function android(h = handle(), release = apkRel()) {
    const openAppUpdate = vi.fn(() => h);
    const r = make({ kind: 'tauri-android', fetch: releases(release) as never, target: async () => ({ os: 'android', arch: 'aarch64' }), openAppUpdate });
    return { ...r, h, openAppUpdate };
  }

  test('checks on every launch, however recent the last check was', () => {
    localStorage.setItem('bhp.upd.checked', String(1_000_000_000_000 - 1000));
    const a = android();
    a.u.autoStart();
    expect(a.deps.fetch).toHaveBeenCalled();
    const desk = make();
    localStorage.setItem('bhp.upd.checked', String(1_000_000_000_000 - 1000));
    desk.u.autoStart();
    expect(desk.deps.fetch).not.toHaveBeenCalled();
  });
  test('the offer carries the APK for this ABI and the checksum list; it installs in the app', async () => {
    const { u, h, openAppUpdate, deps } = android();
    await u.check();
    expect(u.info?.inPlace).toBe(true);
    expect(u.info?.download).toEqual({
      name: 'blockheads-patcher-0.2.0-android-arm64.apk', url: 'https://github.com/dl/blockheads-patcher-0.2.0-android-arm64.apk', size: 5_000_000,
      sumsUrl: 'https://github.com/dl/SHA256SUMS.txt'
    });
    await u.install();
    expect(openAppUpdate).toHaveBeenCalledWith(u.info!.download, '0.2.0');
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(u.stage).toBe('ready');
    await u.restart();
    expect(h.install).toHaveBeenCalled();
  });
  test('a release without SHA256SUMS.txt is offered without a checksum list', async () => {
    const { u } = android(handle(), rel('v0.2.0'));
    await u.check();
    expect(u.info?.download).not.toHaveProperty('sumsUrl');
  });
  test('a failed download falls back to the browser', async () => {
    const { u, deps } = android(handle({ download: vi.fn(async () => { throw new Error('checksum mismatch'); }) }));
    await u.check();
    await u.install();
    expect(u.error).toBe('checksum mismatch');
    expect(deps.openUrl).toHaveBeenCalledWith('https://github.com/dl/blockheads-patcher-0.2.0-android-arm64.apk');
  });
  test('"install unknown apps" not allowed: stays ready with a hint, the next tap installs', async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error(INSTALL_NOT_ALLOWED)).mockResolvedValueOnce(undefined);
    const { u, h } = android(handle({ install }));
    await u.check();
    await u.install();
    await u.restart();
    expect([u.stage, u.needsInstallPermission, u.installFailed]).toEqual(['ready', true, false]);
    expect(h.close).not.toHaveBeenCalled();
    await u.restart();
    expect(u.needsInstallPermission).toBe(false);
    expect(install).toHaveBeenCalledTimes(2);
    u.cancelDownload();
    expect(u.needsInstallPermission).toBe(false);
  });
  test('createUpdateState passes the platform’s update opener', async () => {
    const h = handle();
    const openAppUpdate = vi.fn(() => h);
    const u = createUpdateState(mockPlatform({ kind: 'tauri-android', updateTarget: async () => ({ os: 'android' as const, arch: 'aarch64' }), openAppUpdate }), '0.0.1');
    vi.stubGlobal('fetch', releases(apkRel()));
    await u.check();
    await u.install();
    expect(openAppUpdate).toHaveBeenCalled();
  });
});

describe('createUpdateState', () => {
  test('wires the platform', async () => {
    const openUrl = vi.fn(async () => {});
    const updateTarget = vi.fn(async () => ({ os: 'android' as const, arch: 'aarch64' }));
    const desk = createUpdateState(mockPlatform({ kind: 'tauri-desktop', checkInPlaceUpdate: async () => null, restart: async () => {} }), '0.0.1');
    expect(desk.kind).toBe('tauri-desktop');
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

describe('in-place update (desktop, Tauri updater)', () => {
  type Ev = { done: number; total: number | null };
  function handle(over: Partial<InPlaceUpdate> = {}, events: Ev[] = [{ done: 0, total: 1000 }, { done: 500, total: 1000 }, { done: 1000, total: 1000 }]) {
    return {
      version: '0.2.0',
      download: vi.fn(async (cb: (p: Ev) => void) => { for (const e of events) cb(e); }),
      install: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      ...over
    } satisfies InPlaceUpdate;
  }
  function setup(h: InPlaceUpdate | null | (() => Promise<InPlaceUpdate | null>), over: Partial<UpdateDeps> = {}) {
    let t = 1000;
    const checkInPlace = vi.fn(typeof h === 'function' ? h : async () => h);
    const restart = vi.fn(async () => {});
    const r = make({ checkInPlace, restart, now: () => (t += 1000), ...over });
    return { ...r, checkInPlace, restart };
  }

  test('only offered with the updater and a matching file', async () => {
    const { u } = setup(handle());
    await u.check();
    expect(u.info?.inPlace).toBe(true);
    const deb = setup(handle(), { target: async () => ({ os: 'linux', arch: 'x86_64' }) });
    await deb.u.check();
    expect(deb.u.info?.inPlace).toBe(false);
  });
  test('download with progress, then ready; Restart now installs and restarts', async () => {
    const h = handle();
    const { u, restart, deps } = setup(h);
    await u.check();
    expect(u.percent).toBe(0);
    await u.install();
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(u.stage).toBe('ready');
    expect(u.progress).toEqual({ done: 1000, total: 1000, speed: expect.any(Number), eta: 0 });
    expect(u.percent).toBe(100);
    const done = u.restart();
    expect(u.stage).toBe('installing');
    await done;
    expect(h.install).toHaveBeenCalled();
    expect(restart).toHaveBeenCalled();
  });
  test('progress: speed and time left, unknown size, capped percent', async () => {
    const seen: unknown[] = [];
    const events = [{ done: 300, total: 1200 }, { done: 50, total: null }, { done: 2000, total: 1000 }];
    let t = 0;
    const h = handle({ download: vi.fn(async (cb: (p: Ev) => void) => { for (const e of events) { cb(e); seen.push({ ...u.progress, percent: u.percent }); } }) });
    const { u } = setup(h, { now: () => t });
    await u.check();
    t = 0;
    const run = u.install();
    await vi.waitFor(() => expect(h.download).toHaveBeenCalled());
    await run;
    // the clock does not move: no speed, no estimate
    expect(seen[0]).toEqual({ done: 300, total: 1200, speed: 0, eta: null, percent: 25 });
    expect(seen[1]).toEqual({ done: 50, total: null, speed: 0, eta: null, percent: 0 });
    expect((seen[2] as { percent: number }).percent).toBe(100);
  });
  test('falls back to the browser: no update at the endpoint, another version, updater or download error', async () => {
    const cases: [InPlaceUpdate | null | (() => Promise<InPlaceUpdate | null>), string][] = [
      [null, ''],
      [handle({ version: '0.1.9' }), ''],
      [async () => { throw new Error('endpoint down'); }, 'endpoint down'],
      [handle({ download: vi.fn(async () => { throw new Error('bad signature'); }) }), 'bad signature'],
      [handle({ download: vi.fn(async () => { throw new Error('x'); }), close: vi.fn(async () => { throw new Error('closed'); }) }), 'x']
    ];
    for (const [h, error] of cases) {
      const { u, deps } = setup(h);
      await u.check();
      await u.install();
      expect([u.stage, u.handedOff, u.progress, u.error]).toEqual(['available', true, null, error]);
      expect(deps.openUrl).toHaveBeenCalledWith('https://github.com/dl/Blockheads.Patcher_0.2.0_x64-setup.exe');
    }
    const other = handle({ version: '0.1.9' });
    const s = setup(other);
    await s.u.check();
    await s.u.install();
    expect(other.close).toHaveBeenCalled();
  });
  test('Cancel download: while looking for the update, while downloading, or when the download then fails', async () => {
    let resolve!: (h: InPlaceUpdate) => void;
    const h1 = handle();
    const a = setup(() => new Promise((r) => { resolve = r; }));
    await a.u.check();
    const p1 = a.u.install();
    a.u.cancelDownload();
    expect([a.u.stage, a.u.progress]).toEqual(['available', null]);
    resolve(h1);
    await p1;
    expect(h1.close).toHaveBeenCalled();
    expect(a.u.stage).toBe('available');

    let feed!: (p: Ev) => void, finish!: () => void;
    const h2 = handle({ download: vi.fn((cb: (p: Ev) => void) => new Promise<void>((r) => { feed = cb; finish = r; })) });
    const b = setup(h2);
    await b.u.check();
    const p2 = b.u.install();
    await vi.waitFor(() => expect(h2.download).toHaveBeenCalled());
    feed({ done: 10, total: 100 });
    expect(b.u.percent).toBe(10);
    b.u.cancelDownload();
    feed({ done: 50, total: 100 });
    expect(b.u.progress).toBeNull();
    finish();
    await p2;
    expect(h2.close).toHaveBeenCalled();
    expect(b.u.stage).toBe('available');

    let fail!: (e: Error) => void;
    const h3 = handle({ download: vi.fn(() => new Promise<void>((_, rej) => { fail = rej; })) });
    const c = setup(h3);
    await c.u.check();
    const p3 = c.u.install();
    await vi.waitFor(() => expect(h3.download).toHaveBeenCalled());
    c.u.cancelDownload();
    fail(new Error('aborted'));
    await p3;
    expect([c.u.stage, c.u.handedOff, c.deps.openUrl]).toEqual(['available', false, c.deps.openUrl]);
    expect(c.deps.openUrl).not.toHaveBeenCalled();
  });
  test('while updating, checks only open the popup; a channel change drops the download', async () => {
    const h = handle({ close: vi.fn(async () => { throw new Error('gone'); }) });
    const { u, deps } = setup(h);
    await u.check();
    await u.install();
    expect(u.stage).toBe('ready');
    await u.check();
    expect([u.stage, u.open]).toEqual(['ready', false]);
    await u.check({ popup: true });
    expect([u.stage, u.open]).toEqual(['ready', true]);
    u.show();
    expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    u.setChannel('beta');
    expect([u.stage, u.progress, u.info]).toEqual(['idle', null, null]);
    expect(h.close).toHaveBeenCalled();
    await u.restart(); // nothing downloaded any more
    expect(h.install).not.toHaveBeenCalled();
  });
  test('a failed install: error stage with the reason; the next check clears it; no restart seam is fine', async () => {
    const h = handle({ install: vi.fn(async () => { throw new Error('access denied'); }) });
    const { u, restart } = setup(h);
    await u.check();
    await u.install();
    await u.restart();
    expect([u.stage, u.installFailed, u.error]).toEqual(['error', true, 'access denied']);
    expect(restart).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
    await u.check();
    expect(u.installFailed).toBe(false);

    const failing = handle({ install: vi.fn(async () => { throw new Error('y'); }), close: vi.fn(async () => { throw new Error('z'); }) });
    const f = setup(failing);
    await f.u.check();
    await f.u.install();
    await f.u.restart();
    expect(f.u.error).toBe('y');

    const ok = handle();
    const n = setup(ok, { restart: undefined });
    await n.u.check();
    await n.u.install();
    await n.u.restart();
    expect(ok.install).toHaveBeenCalled();
  });
});
