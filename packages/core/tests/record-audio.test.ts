import { describe, it, expect } from 'vitest';
import {
  parseAxml, getAttr, findElementsByName, ANDROID_NS, PatchError, defaultRegistry, BLOCKHEADS_PACKAGE, RECORD_AUDIO_PERMISSION, recordAudio,
  type PatchContext,
} from '../src';
import { build, type BEl } from './axml-builder';

const tree = (perms: string[], root = 'manifest'): BEl => ({
  name: root,
  attrs: [{ name: 'package', str: BLOCKHEADS_PACKAGE }],
  children: [
    { name: 'uses-sdk', attrs: [{ name: 'targetSdkVersion', res: 0x01010270, type: 0x10, data: 27 }] },
    ...perms.map((p) => ({ name: 'uses-permission', attrs: [{ name: 'name', res: 0x01010003, str: p }] })),
    { name: 'application' },
  ],
});
const ctxOf = (t: BEl) => {
  let dirty = 0;
  const logs: string[] = [];
  const ctx: PatchContext = { zip: { entries: [] }, manifest: parseAxml(build(t)), info: { packageName: BLOCKHEADS_PACKAGE, sha256: '' },
    markManifestDirty: () => { dirty++; }, log: (m) => logs.push(m) };
  return { ctx, dirty: () => dirty, logs };
};
const perms = (ctx: PatchContext) => findElementsByName(ctx.manifest, 'uses-permission', RECORD_AUDIO_PERMISSION);

describe('record-audio', () => {
  it('is registered, opt-in, uncredited and limited to the supported game versions', () => {
    expect(defaultRegistry.get('record-audio')).toBe(recordAudio);
    expect(RECORD_AUDIO_PERMISSION).toBe('android.permission.RECORD_AUDIO');
    expect(recordAudio).toMatchObject({ version: 1, optIn: true, nameKey: 'patch.record-audio.name', descriptionKey: 'patch.record-audio.description' });
    expect(recordAudio.credits).toBeUndefined();
    expect(recordAudio.appliesTo).toEqual({ packageName: BLOCKHEADS_PACKAGE, versionNames: ['1.7.4', '1.7.5', '1.7.6'] });
  });

  it('inserts the permission after the last existing uses-permission', () => {
    const c = ctxOf(tree(['android.permission.INTERNET', 'android.permission.WAKE_LOCK']));
    expect(recordAudio.detect(c.ctx)).toBe('notApplied');
    recordAudio.apply(c.ctx);
    expect(c.dirty()).toBe(1);
    expect(c.logs).toEqual([`record-audio: added ${RECORD_AUDIO_PERMISSION}`]);
    expect(recordAudio.detect(c.ctx)).toBe('applied');
    const p = perms(c.ctx);
    expect(p).toHaveLength(1);
    expect(getAttr(p[0]!, 'name', ANDROID_NS, 0x01010003)!.stringValue).toBe(RECORD_AUDIO_PERMISSION);
    expect(c.ctx.manifest.root.children.map((e) => e.name)).toEqual(['uses-sdk', 'uses-permission', 'uses-permission', 'uses-permission', 'application']);
    expect(c.ctx.manifest.root.children.indexOf(p[0]!)).toBe(3);
  });

  it('inserts at the start when there is no uses-permission yet', () => {
    const c = ctxOf(tree([]));
    expect(recordAudio.detect(c.ctx)).toBe('notApplied');
    recordAudio.apply(c.ctx);
    expect(recordAudio.detect(c.ctx)).toBe('applied');
    expect(c.ctx.manifest.root.children.indexOf(perms(c.ctx)[0]!)).toBe(0);
  });

  it('refuses to apply twice, or to an already declared permission', () => {
    const c = ctxOf(tree(['android.permission.INTERNET']));
    recordAudio.apply(c.ctx);
    expect(() => recordAudio.apply(c.ctx)).toThrow(/status: applied/);
    const d = ctxOf(tree([RECORD_AUDIO_PERMISSION]));
    expect(recordAudio.detect(d.ctx)).toBe('applied');
    try {
      recordAudio.apply(d.ctx);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PatchError);
      expect((e as PatchError).code).toBe('cannotApply');
    }
    expect(d.dirty()).toBe(0);
    expect(perms(d.ctx)).toHaveLength(1);
  });

  it('is incompatible when the manifest root is not <manifest>', () => {
    const c = ctxOf(tree([RECORD_AUDIO_PERMISSION], 'other'));
    expect(recordAudio.detect(c.ctx)).toBe('incompatible');
    expect(() => recordAudio.apply(c.ctx)).toThrow(/status: incompatible/);
  });
});
