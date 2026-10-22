import { describe, expect, test, vi } from 'vitest';
import {
  compareVersions, fetchLatestRelease, isNewer, parseDeployedVersion, parseVersion, pickAsset, pickLatestRelease,
  releaseNoteItems, type Release, type ReleaseAsset
} from '../src';

const rel = (tag: string, over: Partial<Release> = {}): Release => ({
  tag_name: tag, draft: false, prerelease: false, html_url: `https://example.test/${tag}`, body: '', assets: [], ...over
});

describe('versions', () => {
  test('parses plain, v-prefixed, pre-release and build-metadata versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseVersion(' v0.10.0-rc.1+abc ')).toEqual({ major: 0, minor: 10, patch: 0, pre: ['rc', '1'] });
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('01.2.3')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
  test('orders by semver precedence', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    // pre-releases sort before the release, numeric < alphanumeric, shorter prefix first
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0-1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
    // unparsable sorts first
    expect(compareVersions('nope', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('0.0.1', 'nope')).toBeGreaterThan(0);
    expect(compareVersions('x', 'y')).toBe(0);
  });
  test('isNewer needs a valid candidate', () => {
    expect(isNewer('0.2.0', '0.1.1')).toBe(true);
    expect(isNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isNewer('junk', '0.1.1')).toBe(false);
  });
});

describe('pickLatestRelease', () => {
  const list = [
    rel('v0.1.0'), rel('v0.3.0', { draft: true }), rel('v0.2.0-rc.1', { prerelease: true }), rel('v0.1.1'),
    rel('v0.2.1-beta.1'), rel('nightly'), rel('0.9.0')
  ];
  test('stable only: skips drafts, pre-releases (flag or suffix) and non-version tags', () => {
    expect(pickLatestRelease(list)?.tag_name).toBe('v0.1.1');
  });
  test('pre-releases when allowed', () => {
    expect(pickLatestRelease(list, true)?.tag_name).toBe('v0.2.1-beta.1');
  });
  test('nothing eligible', () => {
    expect(pickLatestRelease([rel('v1.0.0', { draft: true })])).toBeNull();
    expect(pickLatestRelease([])).toBeNull();
  });
});

describe('releaseNoteItems', () => {
  const body = [
    'Early release.', '', '## What\'s new', '',
    '- **Russian and Kazakh UI.** See [the docs](https://x.test).', '* `code` and _soft_ words', '  - nested is skipped',
    '+ plus', '- ', '', '## Fixes', '- not in notes'
  ].join('\r\n');
  test('bullets of the What’s new section, as plain text', () => {
    expect(releaseNoteItems(body)).toEqual(['Russian and Kazakh UI. See the docs.', 'code and soft words', 'plus']);
  });
  test('whole body without the heading, capped at max', () => {
    expect(releaseNoteItems('- a\n- b\n- c', 2)).toEqual(['a', 'b']);
    expect(releaseNoteItems('## Fixes\n- a\n## Other\n- b')).toEqual(['a', 'b']);
  });
  test('empty bodies', () => {
    expect(releaseNoteItems(null)).toEqual([]);
    expect(releaseNoteItems(undefined)).toEqual([]);
  });
});

describe('pickAsset', () => {
  const names = [
    'blockheads-patcher-0.2.0-android-arm.apk', 'blockheads-patcher-0.2.0-android-arm64.apk', 'blockheads-patcher-0.2.0-android-x86_64.apk',
    'Blockheads.Patcher_0.2.0_aarch64.AppImage', 'Blockheads.Patcher_0.2.0_amd64.AppImage', 'Blockheads.Patcher_0.2.0_amd64.deb',
    'Blockheads.Patcher_0.2.0_arm64-setup.exe', 'Blockheads.Patcher_0.2.0_x64-setup.exe', 'Blockheads.Patcher_0.2.0_x64_en-US.msi',
    'Blockheads.Patcher_0.2.0_aarch64.dmg', 'Blockheads.Patcher_0.2.0_universal.dmg'
  ];
  const assets: ReleaseAsset[] = names.map((name, i) => ({ name, size: i, browser_download_url: `https://dl.test/${name}` }));
  const pick = (os: 'windows' | 'macos' | 'linux' | 'android', arch: string, appimage?: boolean) => pickAsset(assets, { os, arch, appimage })?.name ?? null;
  test('per platform and architecture', () => {
    expect(pick('windows', 'x86_64')).toBe('Blockheads.Patcher_0.2.0_x64-setup.exe');
    expect(pick('windows', 'aarch64')).toBe('Blockheads.Patcher_0.2.0_arm64-setup.exe');
    expect(pick('macos', 'aarch64')).toBe('Blockheads.Patcher_0.2.0_aarch64.dmg');
    expect(pick('macos', 'x86_64')).toBe('Blockheads.Patcher_0.2.0_universal.dmg');
    expect(pick('linux', 'x86_64', true)).toBe('Blockheads.Patcher_0.2.0_amd64.AppImage');
    expect(pick('android', 'aarch64')).toBe('blockheads-patcher-0.2.0-android-arm64.apk');
    expect(pick('android', 'arm')).toBe('blockheads-patcher-0.2.0-android-arm.apk');
    expect(pick('android', 'x86_64')).toBe('blockheads-patcher-0.2.0-android-x86_64.apk');
  });
  test('no match: deb/rpm installs, unknown arch, missing file', () => {
    expect(pick('linux', 'x86_64')).toBeNull();
    expect(pick('windows', 'riscv64')).toBeNull();
    expect(pick('windows', 'arm')).toBeNull();
    expect(pickAsset([], { os: 'android', arch: 'aarch64' })).toBeNull();
  });
});

describe('parseDeployedVersion', () => {
  test('version.json and patcher-version.txt', () => {
    expect(parseDeployedVersion('{"version":"0.2.0"}')).toBe('0.2.0');
    expect(parseDeployedVersion('v0.2.0 0123abcd\n')).toBe('0.2.0');
    expect(parseDeployedVersion('v0.3.0-rc.1')).toBe('0.3.0-rc.1');
  });
  test('no version', () => {
    expect(parseDeployedVersion('{"version":3}')).toBeNull();
    expect(parseDeployedVersion('null')).toBeNull();
    expect(parseDeployedVersion('dev abc')).toBeNull();
    expect(parseDeployedVersion('<!doctype html>')).toBeNull();
    expect(parseDeployedVersion('')).toBeNull();
  });
});

describe('fetchLatestRelease', () => {
  test('requests the repo releases and picks the newest', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([rel('v0.1.0'), rel('v0.2.0-rc.1')]), { status: 200 }));
    expect((await fetchLatestRelease(fetcher as never))?.tag_name).toBe('v0.1.0');
    expect(fetcher.mock.calls[0]).toEqual([
      'https://api.github.com/repos/Blockheads-Club/blockheads-patcher/releases?per_page=20',
      expect.objectContaining({ cache: 'no-store', headers: { accept: 'application/vnd.github+json' } })
    ]);
    expect((await fetchLatestRelease(fetcher as never, { allowPrerelease: true, repo: 'o/r' }))?.tag_name).toBe('v0.2.0-rc.1');
    expect((fetcher.mock.calls[1] as unknown[])[0]).toBe('https://api.github.com/repos/o/r/releases?per_page=20');
  });
  test('HTTP errors reject', async () => {
    const fetcher = vi.fn(async () => new Response('rate limited', { status: 403 }));
    await expect(fetchLatestRelease(fetcher as never)).rejects.toThrow('HTTP 403');
  });
});
