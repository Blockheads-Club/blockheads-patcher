import { describe, it, expect } from 'vitest';
import {
  ANDROID_NS, ValueType, applyPatches, buildPackArchive, CORE_VERSION, defaultRegistry, fixConfigChangeCrash, getAttr, getEntry, listPatches, loadApk,
  loadPack, MemoryKeystore, packPatchId, isPackPatch, patchApk, readZip, registryWithPacks, sha256HexSync, validateDex, DexFile, findElements,
  type LoadedApk, type Pack, type PackIssue, type PatchContext,
} from '../src';
import { calleeOf, insnsOf } from '../src/patches/dex-support';
import { buildDex, type ClsSpec, type Unit } from './dex/fixture';
import { CODE } from './elf-fixture';
import { OBJC, SYM, buildSymElf } from './sym-elf-fixture';
import { BLOCKHEADS, WEBVIEW, makeApk, type ManifestOpts } from './synthetic-apk';

const enc = new TextEncoder();
const dec = new TextDecoder();
const LIB = 'lib/armeabi-v7a/libgame.so';
const ACT = 'Lcom/apportable/activity/VerdeActivity;';
const BUNDLE = 'Landroid/os/Bundle;';
const HELLO = 'Lcom/example/pack/Hello;';
const RET: Unit[] = [0x000e];

type Json = Record<string, unknown>;
const base = (patches: Json[], over: Json = {}): Json => ({
  schemaVersion: 1, id: 'demo', version: '1.2.3', name: { en: 'Demo pack', tr: 'Deneme paketi' }, author: 'Someone',
  description: { en: 'A pack for tests' }, appliesTo: { packageName: BLOCKHEADS }, patches, ...over,
});
const patch = (ops: Json[], over: Json = {}): Json => ({ id: 'p', name: { en: 'Patch', tr: 'Yama' }, description: { en: 'Does things' }, ops, ...over });
const bhpack = (json: unknown, files: Record<string, Uint8Array> = {}): Uint8Array =>
  buildPackArchive({ 'pack.json': enc.encode(typeof json === 'string' ? json : JSON.stringify(json)), ...files });
const ok = (json: unknown, files: Record<string, Uint8Array> = {}): Pack => {
  const r = loadPack(bhpack(json, files));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.pack;
};
const errs = (bytes: Uint8Array, opts?: Parameters<typeof loadPack>[1]): PackIssue[] => {
  const r = loadPack(bytes, opts);
  if (r.ok) throw new Error('expected the pack to be refused');
  return r.errors;
};
const codes = (bytes: Uint8Array, opts?: Parameters<typeof loadPack>[1]): string[] => errs(bytes, opts).map((e) => e.code);
const one = (ops: Json[], files: Record<string, Uint8Array> = {}): Pack => ok(base([patch(ops)]), files);

const PLIST = `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>UIAppFonts</key>\n\t<array>\n\t\t<string>A.ttf</string>\n\t</array>\n\t<key>Name</key>\n\t<string>Old</string>\n</dict>\n</plist>\n`;
const activity = (extra: ClsSpec['virtual'] = []): ClsSpec => ({
  name: ACT, super: 'Landroid/app/Activity;',
  virtual: [{ name: 'onCreate', ret: 'V', params: [BUNDLE], flags: 4, code: { regs: 5, ins: 2, outs: 0, insns: RET } }, ...extra],
  direct: [
    { name: 'boot', ret: 'V', params: [], flags: 9, code: { regs: 1, ins: 0, outs: 0, insns: RET } },
    { name: 'nat', ret: 'V', params: [], flags: 0x109 },
  ],
});
const gameDex = (): Uint8Array => buildDex({ classes: [activity()] });
const helloDex = (name = HELLO): Uint8Array => buildDex({ classes: [{
  name, super: 'Ljava/lang/Object;',
  direct: [
    { name: 'start', ret: 'V', params: [], flags: 9, code: { regs: 0, ins: 0, outs: 0, insns: RET } },
    { name: 'withThis', ret: 'V', params: [ACT], flags: 9, code: { regs: 1, ins: 1, outs: 0, insns: RET } },
    { name: 'withObj', ret: 'V', params: ['Ljava/lang/Object;'], flags: 9, code: { regs: 1, ins: 1, outs: 0, insns: RET } },
  ],
  virtual: [{ name: 'inst', ret: 'V', params: [], flags: 1, code: { regs: 1, ins: 1, outs: 0, insns: RET } }],
}] });

async function apk(extra: { name: string; data: Uint8Array }[] = [], o: ManifestOpts = {}): Promise<LoadedApk> {
  return loadApk(makeApk(o, [{ name: 'assets/Info.plist', data: enc.encode(PLIST) }, ...extra]));
}
function run(a: LoadedApk, packs: Pack[], ids?: string[]) {
  const { registry } = registryWithPacks(packs);
  const report = listPatches(a, registry);
  const status = Object.fromEntries(report.filter((r) => isPackPatch(r.patch)).map((r) => [r.patch.id, r.status]));
  const result = ids ? applyPatches(a, ids, registry) : undefined;
  const after = Object.fromEntries(listPatches(a, registry).filter((r) => isPackPatch(r.patch)).map((r) => [r.patch.id, r.status]));
  return { status, result, after, registry };
}
const PID = packPatchId('demo', 'p');
const ctxOf = (a: LoadedApk): PatchContext => ({ zip: a.zip, manifest: a.manifest, info: a.info, markManifestDirty() {}, log() {} });
const text = (a: LoadedApk, name: string): string => dec.decode(getEntry(a.zip, name)!.data);
const webview = (a: LoadedApk) => findElements(a.manifest, (e) => e.name === 'activity')[0]!;
const application = (a: LoadedApk) => findElements(a.manifest, (e) => e.name === 'application')[0]!;

describe('loadPack: archive and manifest checks', () => {
  it('loads a valid pack into namespaced, opt-in patches with their own texts', () => {
    const p = ok(base([patch([{ op: 'file.add', path: 'assets/x.txt', from: 'files/x.txt' }], { summary: { en: 'Short', tr: 'Kısa' } })]), { 'files/x.txt': enc.encode('x') });
    expect(p).toMatchObject({ id: 'demo', version: '1.2.3', author: 'Someone', name: { en: 'Demo pack' }, description: { en: 'A pack for tests' } });
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [x] = p.patches;
    expect(x).toMatchObject({ id: 'pack:demo/p', nameKey: 'patch.pack:demo/p.name', descriptionKey: 'patch.pack:demo/p.description', optIn: true,
      source: { kind: 'pack', packId: 'demo', packName: 'Demo pack', packVersion: '1.2.3' }, appliesTo: { packageName: BLOCKHEADS } });
    expect(x!.texts).toEqual({ en: { name: 'Patch', summary: 'Short', description: 'Does things' }, tr: { name: 'Yama', summary: 'Kısa', description: 'Does things' } });
    expect(isPackPatch(x!)).toBe(true);
    expect(isPackPatch(fixConfigChangeCrash)).toBe(false);
    const bare = ok({ ...base([patch([{ op: 'manifest.remove', target: 'application', attr: 'allowBackup' }])]), author: undefined, description: undefined });
    expect(bare.author).toBeUndefined();
    expect(bare.description).toBeUndefined();
    expect(bare.patches[0]!.texts!.en!.summary).toBe('Does things');
    const mixed = ok(base([patch([{ op: 'manifest.remove', target: 'application', attr: 'allowBackup' }], { description: { en: 'Does things', de: 'Macht' }, summary: { en: 'S' } })]));
    expect(mixed.patches[0]!.texts).toEqual({
      en: { name: 'Patch', summary: 'S', description: 'Does things' },
      tr: { name: 'Yama', summary: 'S', description: 'Does things' },
      de: { name: 'Patch', summary: 'S', description: 'Macht' },
    });
  });

  it('refuses oversized packs', () => {
    const good = bhpack(base([patch([{ op: 'file.add', path: 'assets/x', from: 'x' }])]), { x: new Uint8Array(1000) });
    expect(codes(new Uint8Array((64 << 20) + 1))).toEqual(['tooLarge']);
    expect(codes(good, { limits: { packBytes: 100 } })).toEqual(['tooLarge']);
    expect(codes(good, { limits: { entries: 1 } })).toEqual(['tooLarge']);
    expect(errs(good, { limits: { entryBytes: 999 } })[0]).toMatchObject({ code: 'tooLarge', path: 'x' });
    expect(codes(good, { limits: { totalBytes: 1000 } })).toEqual(['tooLarge']);
    expect(errs(good, { limits: { manifestBytes: 10 } })[0]).toMatchObject({ code: 'tooLarge', path: 'pack.json' });
    expect(loadPack(good, { limits: { packBytes: 1 << 30 } }).ok).toBe(true);
  });

  it('refuses archives that are not packs', () => {
    expect(codes(enc.encode('hello'))).toEqual(['notZip']);
    expect(codes(buildPackArchive({ 'x.txt': enc.encode('x') }))).toEqual(['noManifest']);
    expect(codes(bhpack('{ nope'))).toEqual(['badJson']);
    expect(codes(buildPackArchive({ 'pack.json': new Uint8Array([0xff, 0xfe]) }))).toEqual(['badJson']);
    const corrupt = bhpack(base([patch([{ op: 'file.add', path: 'assets/x', from: 'x' }])]), { x: enc.encode('payload payload payload') });
    const at = corrupt.indexOf(0x50, 30); // somewhere after the first local header: flip a data byte of the first entry
    corrupt[at + 40] = corrupt[at + 40]! ^ 0xff;
    expect(codes(corrupt)).toContain('badEntry');
  });

  it('refuses unsafe file names (path traversal)', () => {
    for (const name of ['../evil', 'a/../b', '/abs', 'a\\b', './x', 'files/.hidden', 'c:/x', '']) {
      const e = errs(buildPackArchive({ 'pack.json': enc.encode('{}'), [name]: enc.encode('x') }));
      expect(e[0], name).toMatchObject({ code: 'badEntry' });
    }
    // directories are fine and ignored
    expect(loadPack(buildPackArchive({ 'pack.json': enc.encode(JSON.stringify(base([patch([{ op: 'file.add', path: 'assets/x', from: 'd/x' }])]))), 'd/': new Uint8Array(0), 'd/x': enc.encode('x') })).ok).toBe(true);
  });

  it('checks the format version and the patcher version', () => {
    expect(codes(bhpack({ ...base([]), schemaVersion: 2 }))).toEqual(['unsupportedSchema']);
    expect(codes(bhpack('null'))).toEqual(['schema']);
    const future = bhpack(base([patch([{ op: 'manifest.remove', target: 'application', attr: 'allowBackup' }])], { minPatcherVersion: '99.0.0' }));
    expect(errs(future)[0]!.message).toContain(`99.0.0 or newer (this is ${CORE_VERSION})`);
    expect(loadPack(future, { patcherVersion: '99.0.0' }).ok).toBe(true);
    expect(loadPack(future, { patcherVersion: '99.0.1' }).ok).toBe(true);
    expect(loadPack(bhpack(base([patch([{ op: 'manifest.remove', target: 'application', attr: 'allowBackup' }])], { minPatcherVersion: '0.0.9' }))).ok).toBe(true);
  });

  it('reports schema errors with their JSON pointer', () => {
    const e = errs(bhpack(base([patch([{ op: 'file.add', path: '../x', from: 'x' }, { op: 'lib.replace' }])], { id: 'Bad Id', extra: 1 })));
    expect(e.every((x) => x.code === 'schema')).toBe(true);
    expect(e.map((x) => x.path)).toEqual(expect.arrayContaining(['/id', '/extra', '/patches/0/ops/0/path', '/patches/0/ops/1/op']));
    expect(codes(bhpack(base([patch([{ op: 'file.add', path: 'lib/armeabi-v7a/libx.so', from: 'x' }])])))).toEqual(['schema']);
    expect(codes(bhpack(base([patch([{ op: 'file.replace', path: 'META-INF/MANIFEST.MF', from: 'x' }])])))).toEqual(['schema']);
    expect(codes(bhpack(base([patch([{ op: 'file.replace', path: 'classes.dex', from: 'x' }])])))).toEqual(['schema']);
    expect(codes(bhpack(base([patch([{ op: 'file.add', path: 'assets/../classes.dex', from: 'x' }])])))).toEqual(['schema']);
    expect(codes(bhpack(base([patch([{ op: 'file.add', path: 'assets/x', from: 'pack.json' }])])))).toEqual(['schema']);
    expect(codes(bhpack(base([patch([{ op: 'manifest.set', target: 'application', attr: 'debuggable', value: true }])])))).toEqual(['schema']);
    expect(codes(bhpack(base([patch([{ op: 'native.patch', lib: LIB, locate: { symbol: 'x', vaddr: 1 }, expect: '00', replace: '01' }])])))).toEqual(['schema']);
    expect(codes(bhpack(base([patch([{ op: 'dex.hook', class: ACT, method: 'onCreate', call: `${HELLO}->start(I)V` }])])))).toEqual(['schema']);
  });

  it('checks references between pack.json and the files', () => {
    expect(errs(bhpack(base([patch([{ op: 'file.add', path: 'assets/x', from: 'x' }])])))).toEqual([{ code: 'missingFile', path: 'x', message: 'x is referenced but not in the pack' }]);
    expect(errs(bhpack(base([patch([{ op: 'manifest.remove', target: 'application', attr: 'allowBackup' }])]), { 'README.md': enc.encode('hi') })))
      .toEqual([{ code: 'unusedFile', path: 'README.md', message: 'README.md is not used by any operation' }]);
    expect(codes(bhpack(base([patch([{ op: 'manifest.remove', target: 'application', attr: 'allowBackup' }]), patch([{ op: 'manifest.remove', target: 'application', attr: 'largeHeap' }])])))).toEqual(['duplicatePatch']);
    expect(codes(bhpack(base([patch([
      { op: 'file.add', path: 'assets/Info.plist', from: 'x' }, { op: 'plist.set', path: 'assets/Info.plist', key: 'K', value: 1 },
      { op: 'manifest.remove', target: 'application', attr: 'allowBackup' }, { op: 'manifest.set', target: 'application', attr: 'allowBackup', value: true },
      { op: 'plist.set', path: 'assets/a.plist', key: 'K', value: 1 }, { op: 'plist.set', path: 'assets/a.plist', key: 'L', value: 1 },
    ])]), { x: enc.encode('x') }))).toEqual(['overlap', 'overlap']);
  });

  it('refuses semantically wrong operations', () => {
    const bad = (op: Json, files: Record<string, Uint8Array> = {}) => errs(bhpack(base([patch([op])]), files)).map((e) => e.message).join('\n');
    expect(bad({ op: 'manifest.set', target: 'application', attr: 'launchMode', value: 1 })).toMatch(/cannot be set on <application>/);
    expect(bad({ op: 'manifest.remove', target: { activity: WEBVIEW }, attr: 'allowBackup' })).toMatch(/cannot be set on <activity>/);
    expect(bad({ op: 'manifest.set', target: 'application', attr: 'label', value: 1 })).toMatch(/needs a string/);
    expect(bad({ op: 'manifest.set', target: 'application', attr: 'allowBackup', value: 'yes' })).toMatch(/needs a boolean/);
    expect(bad({ op: 'manifest.set', target: 'application', attr: 'theme', value: 0x7f010000 })).toMatch(/platform resource id/);
    expect(bad({ op: 'manifest.set', target: 'application', attr: 'theme', value: 'x' })).toMatch(/platform resource id/);
    expect(bad({ op: 'manifest.set', target: { activity: WEBVIEW }, attr: 'configChanges', value: -1 })).toMatch(/non-negative integer/);
    expect(bad({ op: 'manifest.set', target: { activity: WEBVIEW }, attr: 'screenOrientation', value: true })).toMatch(/non-negative integer/);
    expect(bad({ op: 'text.replace', path: 'assets/a.txt', find: 'a', replace: 'xax' })).toMatch(/must not contain `find`/);
    expect(bad({ op: 'native.patch', lib: LIB, locate: { vaddr: 0 }, expect: '0001', replace: '00' })).toMatch(/same length/);
    expect(bad({ op: 'native.patch', lib: LIB, locate: { vaddr: 0 }, expect: '00 01', replace: '0001' })).toMatch(/equals `expect`/);
    expect(bad({ op: 'dex.add', from: 'a.dex' }, { 'a.dex': enc.encode('not a dex') })).toMatch(/not a valid dex/);
    expect(bad({ op: 'dex.add', from: 'a.dex' }, { 'a.dex': buildDex({ classes: [] }) })).toMatch(/defines no classes/);
    expect(bad({ op: 'dex.add', from: 'a.dex' }, { 'a.dex': helloDex('Landroid/app/Evil;') })).toMatch(/reserved namespace/);
    expect(bad({ op: 'dex.add', from: 'a.dex' }, { 'a.dex': helloDex('Lcom/blockheadsclub/patch/LoopGuard;') })).toMatch(/reserved namespace/);
    const hook = (call: string, extra: Json = {}) => errs(bhpack(base([patch([{ op: 'dex.add', from: 'a.dex' }, { op: 'dex.hook', class: ACT, method: 'onCreate', params: [BUNDLE], call, ...extra }])]), { 'a.dex': helloDex() })).map((e) => e.message).join('\n');
    expect(hook(`${HELLO}->withThis(Lcom/other/X;)V`)).toMatch(/may only take the instance/);
    expect(hook(`${HELLO}->start()V`, { method: '<init>', params: [] })).toMatch(/constructors cannot be hooked/);
    expect(hook(`${HELLO}->missing()V`)).toMatch(/must be a static method of a class added by an earlier dex.add/);
    expect(hook(`${HELLO}->inst()V`)).toMatch(/must be a static method/);
    expect(hook(`Lcom/other/Y;->start()V`)).toMatch(/must be a static method/);
    expect(errs(bhpack(base([patch([{ op: 'dex.hook', class: ACT, method: 'onCreate', call: `${HELLO}->start()V` }, { op: 'dex.add', from: 'a.dex' }])]), { 'a.dex': helloDex() }))[0]!.message)
      .toMatch(/earlier dex.add/);
  });
});

describe('pack operations', () => {
  it('manifest.set / manifest.remove on <application> and an activity', async () => {
    const p = one([
      { op: 'manifest.set', target: 'application', attr: 'label', value: 'My Blockheads' },
      { op: 'manifest.set', target: 'application', attr: 'allowBackup', value: false },
      { op: 'manifest.set', target: 'application', attr: 'theme', value: 0x01030010 },
      { op: 'manifest.set', target: { activity: WEBVIEW }, attr: 'screenOrientation', value: 6 },
      { op: 'manifest.set', target: { activity: WEBVIEW }, attr: 'configChanges', value: 0x4a0 },
      { op: 'manifest.remove', target: { activity: WEBVIEW }, attr: 'theme' },
      { op: 'manifest.remove', target: 'application', attr: 'largeHeap' },
    ]);
    const a = await apk();
    const r = run(a, [p], [PID]);
    expect(r.status[PID]).toBe('notApplied');
    expect(r.result).toEqual({ applied: [PID], skipped: [] });
    expect(r.after[PID]).toBe('applied');
    expect(a.manifestDirty).toBe(true);
    const app = application(a), act = webview(a);
    expect(getAttr(app, 'label', ANDROID_NS, 0x01010001)).toMatchObject({ valueType: ValueType.String, stringValue: 'My Blockheads' });
    expect(getAttr(app, 'allowBackup', ANDROID_NS, 0x01010280)).toMatchObject({ valueType: ValueType.IntBoolean, data: 0 });
    expect(getAttr(app, 'theme', ANDROID_NS, 0x01010000)).toMatchObject({ valueType: ValueType.Reference, data: 0x01030010 });
    expect(getAttr(act, 'screenOrientation', ANDROID_NS, 0x0101001e)).toMatchObject({ valueType: ValueType.IntDec, data: 6 });
    expect(getAttr(act, 'configChanges', ANDROID_NS, 0x0101001f)).toMatchObject({ valueType: ValueType.IntHex, data: 0x4a0 });
    expect(getAttr(act, 'theme', ANDROID_NS, 0x01010000)).toBeUndefined();

    // existing attributes are overwritten (string and non-string), and the patch can be re-targeted
    const q = ok(base([patch([
      { op: 'manifest.set', target: 'application', attr: 'label', value: 'Other' },
      { op: 'manifest.set', target: 'application', attr: 'allowBackup', value: true },
    ])], { id: 'demo2' }));
    expect(run(a, [q], [packPatchId('demo2', 'p')]).after[packPatchId('demo2', 'p')]).toBe('applied');
    expect(getAttr(app, 'label', ANDROID_NS, 0x01010001)!.stringValue).toBe('Other');
    expect(getAttr(app, 'allowBackup', ANDROID_NS, 0x01010280)!.data >>> 0).toBe(0xffffffff);
  });

  it('manifest operations are incompatible without their element', async () => {
    const set = one([{ op: 'manifest.set', target: { activity: 'com.example.Missing' }, attr: 'immersive', value: true }]);
    const rm = ok(base([patch([{ op: 'manifest.remove', target: { activity: 'com.example.Missing' }, attr: 'immersive' }], { id: 'q' })]));
    const a = await apk();
    expect(run(a, [set]).status[PID]).toBe('incompatible');
    expect(run(a, [rm]).status[packPatchId('demo', 'q')]).toBe('incompatible');
    expect(() => set.patches[0]!.apply(ctxOf(a))).toThrow(/status: incompatible: no activity com.example.Missing in the manifest/);
  });

  it('file.add and file.replace', async () => {
    const added = enc.encode('new asset');
    const p = ok(base([
      patch([{ op: 'file.add', path: 'assets/new.txt', from: 'f/new.txt' }, { op: 'file.add', path: 'res/raw/same.bin', from: 'f/same.bin' }], { id: 'add' }),
      patch([{ op: 'file.replace', path: 'assets/blob.bin', from: 'f/blob.bin', expectSha256: sha256HexSync(new Uint8Array(100).map((_, i) => i)) }], { id: 'rep' }),
      patch([{ op: 'file.replace', path: 'assets/blob.bin', from: 'f/new.txt', expectSha256: '0'.repeat(64) }], { id: 'wrongsha' }),
      patch([{ op: 'file.replace', path: 'assets/none.bin', from: 'f/new.txt' }], { id: 'missing' }),
      patch([{ op: 'file.add', path: 'assets/blob.bin', from: 'f/same.bin' }], { id: 'exists' }),
    ]), { 'f/new.txt': added, 'f/same.bin': enc.encode('same'), 'f/blob.bin': enc.encode('blob 2') });
    const a = await apk([{ name: 'res/raw/same.bin', data: enc.encode('same') }]);
    const r = run(a, [p], [packPatchId('demo', 'add'), packPatchId('demo', 'rep')]);
    expect(r.status).toEqual({ 'pack:demo/add': 'notApplied', 'pack:demo/rep': 'notApplied', 'pack:demo/wrongsha': 'incompatible', 'pack:demo/missing': 'incompatible', 'pack:demo/exists': 'incompatible' });
    expect(r.after['pack:demo/add']).toBe('applied');
    expect(r.after['pack:demo/rep']).toBe('applied');
    expect(text(a, 'assets/new.txt')).toBe('new asset');
    expect(text(a, 'assets/blob.bin')).toBe('blob 2');
    // a replacement without a hash pin applies to any version of the file
    const loose = ok(base([patch([{ op: 'file.replace', path: 'assets/blob.bin', from: 'x' }])], { id: 'loose' }), { x: enc.encode('3') });
    expect(run(a, [loose], [packPatchId('loose', 'p')]).after[packPatchId('loose', 'p')]).toBe('applied');
  });

  it('plist.set, plist.arrayInsert and text.replace', async () => {
    const p = ok(base([
      patch([
        { op: 'plist.arrayInsert', path: 'assets/Info.plist', key: 'UIAppFonts', value: 'B.ttf' },
        { op: 'plist.set', path: 'assets/Info.plist', key: 'Name', value: 'New' },
        { op: 'plist.set', path: 'assets/Info.plist', key: 'Fresh', value: 42 },
        { op: 'text.replace', path: 'assets/readme.txt', find: 'hello', replace: 'goodbye' },
      ], { id: 'ok' }),
      patch([{ op: 'plist.arrayInsert', path: 'assets/Info.plist', key: 'Name', value: 'x' }], { id: 'notarray' }),
      patch([{ op: 'plist.set', path: 'assets/readme.txt', key: 'K', value: 1 }], { id: 'notplist' }),
      patch([{ op: 'plist.set', path: 'assets/none.plist', key: 'K', value: 1 }], { id: 'nofile' }),
      patch([{ op: 'text.replace', path: 'assets/binary.bin', find: 'a', replace: 'b' }], { id: 'binary' }),
      patch([{ op: 'text.replace', path: 'assets/twice.txt', find: 'ab', replace: 'c' }], { id: 'twice' }),
      patch([{ op: 'text.replace', path: 'assets/twice.txt', find: 'zz', replace: 'c' }], { id: 'none' }),
    ]));
    const a = await apk([
      { name: 'assets/readme.txt', data: enc.encode('say hello $& world') },
      { name: 'assets/binary.bin', data: new Uint8Array([0xff, 0x00, 0xc3]) },
      { name: 'assets/twice.txt', data: enc.encode('ab ab') },
    ]);
    const r = run(a, [p], [packPatchId('demo', 'ok')]);
    expect(r.status).toEqual({ 'pack:demo/ok': 'notApplied', 'pack:demo/notarray': 'incompatible', 'pack:demo/notplist': 'incompatible', 'pack:demo/nofile': 'incompatible',
      'pack:demo/binary': 'incompatible', 'pack:demo/twice': 'incompatible', 'pack:demo/none': 'incompatible' });
    expect(r.after['pack:demo/ok']).toBe('applied');
    const plist = text(a, 'assets/Info.plist');
    expect(plist).toContain('<string>A.ttf</string>\n\t\t<string>B.ttf</string>');
    expect(plist).toContain('<key>Name</key>\n\t<string>New</string>');
    expect(plist).toContain('\t<key>Fresh</key>\n\t<integer>42</integer>\n</dict>');
    expect(text(a, 'assets/readme.txt')).toBe('say goodbye $& world');
  });

  it('native.patch by virtual address, file offset, symbol and Objective-C method', async () => {
    const lib = buildSymElf();
    const word = (at: number): string => Array.from(lib.subarray(at, at + 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
    const p = ok(base([
      patch([{ op: 'native.patch', lib: LIB, locate: { vaddr: CODE }, expect: word(CODE), replace: '1e ff 2f e1', libSha256: sha256HexSync(lib) }], { id: 'vaddr' }),
      patch([{ op: 'native.patch', lib: LIB, locate: { fileOffset: CODE + 0x20 }, expect: word(CODE + 0x20), replace: '00000000' }], { id: 'off' }),
      patch([{ op: 'native.patch', lib: LIB, locate: { symbol: 'my_func', add: 0x20 }, expect: word(SYM.func + 0x20), replace: 'aabbccdd' }], { id: 'sym' }),
      patch([{ op: 'native.patch', lib: LIB, locate: { objcMethod: '-[Foo bar:]' }, expect: word(OBJC.imp), replace: '01020304' }], { id: 'objc' }),
      patch([{ op: 'native.patch', lib: LIB, locate: { objcMethod: '+[Foo make]', add: 0 }, expect: word(OBJC.metaImp), replace: '05060708' }], { id: 'objc2' }),
    ]));
    const a = await apk([{ name: LIB, data: lib }]);
    const ids = ['vaddr', 'off', 'sym', 'objc', 'objc2'].map((x) => packPatchId('demo', x));
    const r = run(a, [p], ids);
    expect(Object.values(r.status)).toEqual(['notApplied', 'notApplied', 'notApplied', 'notApplied', 'notApplied']);
    expect(r.result!.applied).toEqual(ids);
    expect(Object.values(r.after)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    const out = getEntry(a.zip, LIB)!.data;
    expect(Array.from(out.subarray(CODE, CODE + 4))).toEqual([0x1e, 0xff, 0x2f, 0xe1]);
    expect(Array.from(out.subarray(SYM.func + 0x20, SYM.func + 0x24))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(Array.from(out.subarray(OBJC.imp, OBJC.imp + 4))).toEqual([1, 2, 3, 4]);
    expect(out.length).toBe(lib.length);
  });

  it('native.patch refuses anything but the expected bytes', async () => {
    const lib = buildSymElf();
    const n = (id: string, over: Json) => patch([{ op: 'native.patch', lib: LIB, locate: { vaddr: CODE }, expect: 'deadbeef', replace: '00000000', ...over }], { id });
    const word = Array.from(lib.subarray(CODE, CODE + 4), (b) => b.toString(16).padStart(2, '0')).join('');
    const p = ok(base([
      n('mismatch', {}),
      n('sha', { expect: word, libSha256: 'f'.repeat(64) }),
      n('nolib', { lib: 'lib/armeabi-v7a/libnone.so' }),
      n('beyond', { locate: { fileOffset: lib.length - 2 } }),
      n('unbacked', { locate: { vaddr: 0x90000 } }),
      n('nosym', { locate: { symbol: 'nope' } }),
      n('noobjc', { locate: { objcMethod: '-[Foo nope]' } }),
      n('notelf', { lib: 'lib/armeabi-v7a/libtext.so' }),
      n('nosections', { lib: 'lib/armeabi-v7a/libbad.so', locate: { symbol: 'x' } }),
    ]));
    const badSections = buildSymElf(); badSections[50] = 60; // shstrndx out of range
    const a = await apk([{ name: LIB, data: lib }, { name: 'lib/armeabi-v7a/libtext.so', data: enc.encode('text') }, { name: 'lib/armeabi-v7a/libbad.so', data: badSections }]);
    const r = run(a, [p]);
    expect(Object.values(r.status).every((s) => s === 'incompatible')).toBe(true);
    const why = (id: string): string => { try { p.patches.find((x) => x.id === packPatchId('demo', id))!.apply(ctxOf(a)); return ''; } catch (e) { return (e as Error).message; } };
    expect(why('mismatch')).toMatch(/not the expected ones/);
    expect(why('sha')).toMatch(/not the expected build/);
    expect(why('nolib')).toMatch(/libnone.so is missing/);
    expect(why('beyond')).toMatch(/beyond the end/);
    expect(why('unbacked')).toMatch(/not backed by/);
    expect(why('nosym')).toMatch(/symbol nope not found/);
    expect(why('noobjc')).toMatch(/-\[Foo nope\] not found/);
    expect(why('notelf')).toMatch(/not an ELF library/);
    expect(why('nosections')).toMatch(/no readable section headers/);
    // a fileOffset patch works on any file, ELF or not
    const raw = ok(base([patch([{ op: 'native.patch', lib: 'lib/armeabi-v7a/libtext.so', locate: { fileOffset: 1 }, expect: '6578', replace: '4558' }])], { id: 'raw' }));
    expect(run(a, [raw], [packPatchId('raw', 'p')]).after[packPatchId('raw', 'p')]).toBe('applied');
    expect(text(a, 'lib/armeabi-v7a/libtext.so')).toBe('tEXt');
  });

  it('dex.add appends the next classesN.dex and dex.hook calls into it', async () => {
    const p = one([
      { op: 'dex.add', from: 'dex/hello.dex' },
      { op: 'dex.hook', class: ACT, method: 'onCreate', params: [BUNDLE], at: 'start', call: `${HELLO}->withThis(${ACT})V` },
      { op: 'dex.hook', class: ACT, method: 'onCreate', params: [BUNDLE], returns: 'V', call: `${HELLO}->withObj(Ljava/lang/Object;)V` },
      { op: 'dex.hook', class: ACT, method: 'boot', call: `${HELLO}->start()V` },
    ], { 'dex/hello.dex': helloDex() });
    const a = await apk([{ name: 'classes.dex', data: gameDex() }]);
    const r = run(a, [p], [PID]);
    expect(r.status[PID]).toBe('notApplied');
    expect(r.after[PID]).toBe('applied');
    expect(a.zip.entries.map((e) => e.name).filter((n) => n.endsWith('.dex'))).toEqual(['classes.dex', 'classes2.dex']);
    expect(getEntry(a.zip, 'classes2.dex')!.data).toEqual(helloDex());
    const d = DexFile.parse(getEntry(a.zip, 'classes.dex')!.data);
    expect(validateDex(getEntry(a.zip, 'classes.dex')!.data)).toEqual([]);
    const act = d.findClass(ACT)!;
    const body = insnsOf(act, act.findMethod('onCreate', [BUNDLE], 'V')!);
    expect(body.slice(0, 4).map((i) => i.name)).toEqual(['invoke-static/range', 'nop', 'invoke-static/range', 'nop']);
    expect(calleeOf(d, body[0]!)).toMatchObject({ cls: HELLO, name: 'withObj' });
    expect(calleeOf(d, body[2]!)).toMatchObject({ cls: HELLO, name: 'withThis', params: [ACT] });
    const boot = insnsOf(act, act.findMethod('boot', [], 'V')!);
    expect(calleeOf(d, boot[0]!)).toMatchObject({ cls: HELLO, name: 'start', params: [] });
  });

  it('dex operations are incompatible when the APK does not fit', async () => {
    const files = { 'a.dex': helloDex() };
    const p = ok(base([
      patch([{ op: 'dex.add', from: 'a.dex' }], { id: 'add' }),
      patch([{ op: 'dex.add', from: 'a.dex' }, { op: 'dex.hook', class: ACT, method: 'boot', call: `${HELLO}->withThis(${ACT})V` }], { id: 'static' }),
      patch([{ op: 'dex.add', from: 'a.dex' }, { op: 'dex.hook', class: ACT, method: 'nat', call: `${HELLO}->start()V` }], { id: 'native' }),
      patch([{ op: 'dex.add', from: 'a.dex' }, { op: 'dex.hook', class: 'Lcom/none/X;', method: 'a', call: `${HELLO}->start()V` }], { id: 'noclass' }),
    ]), files);
    const st = async (extra: { name: string; data: Uint8Array }[]) => run(await apk(extra), [p]).status;
    expect(await st([])).toEqual({ 'pack:demo/add': 'incompatible', 'pack:demo/static': 'incompatible', 'pack:demo/native': 'incompatible', 'pack:demo/noclass': 'incompatible' });
    expect((await st([{ name: 'classes.dex', data: gameDex() }]))['pack:demo/add']).toBe('notApplied');
    expect((await st([{ name: 'classes.dex', data: gameDex() }, { name: 'classes3.dex', data: buildDex({ classes: [] }) }]))['pack:demo/add']).toBe('incompatible');
    const partial = buildDex({ classes: [activity(), { name: HELLO, super: 'Ljava/lang/Object;' }] });
    const two = buildDex({ classes: [{ name: HELLO, super: 'Ljava/lang/Object;' }, { name: 'Lcom/example/pack/Other;', super: 'Ljava/lang/Object;' }] });
    const q = ok(base([patch([{ op: 'dex.add', from: 'b.dex' }])], { id: 'q' }), { 'b.dex': two });
    expect(run(await apk([{ name: 'classes.dex', data: partial }]), [q]).status[packPatchId('q', 'p')]).toBe('incompatible');
    expect(run(await apk([{ name: 'classes.dex', data: partial }]), [p]).status['pack:demo/add']).toBe('applied');
  });

  it('composes with a built-in dex patch on the same method', async () => {
    const p = one([
      { op: 'dex.add', from: 'a.dex' },
      { op: 'dex.hook', class: ACT, method: 'onCreate', params: [BUNDLE], call: `${HELLO}->start()V` },
    ], { 'a.dex': helloDex() });
    const a = await apk([{ name: 'classes.dex', data: gameDex() }]);
    const r = run(a, [p], ['fix-config-change-crash', PID]);
    expect(r.result).toEqual({ applied: ['fix-config-change-crash', PID], skipped: [] });
    expect(r.after[PID]).toBe('applied');
    expect(fixConfigChangeCrash.detect(ctxOf(a))).toBe('applied');
    for (const n of ['classes.dex', 'classes2.dex']) expect(validateDex(getEntry(a.zip, n)!.data)).toEqual([]);
    const d = DexFile.parse(getEntry(a.zip, 'classes.dex')!.data);
    const act = d.findClass(ACT)!;
    const callees = insnsOf(act, act.findMethod('onCreate', [BUNDLE], 'V')!).map((i) => calleeOf(d, i)?.name).filter(Boolean);
    expect(callees).toEqual(['start', 'install']);
  });

  it('honours exact version codes, input hashes and per-patch appliesTo', async () => {
    const op = { op: 'manifest.remove', target: 'application', attr: 'largeHeap' };
    const p = ok(base([
      patch([op], { id: 'codes', appliesTo: { packageName: BLOCKHEADS, versionCodes: [1, 1548230154] } }),
      patch([op], { id: 'gap', appliesTo: { packageName: BLOCKHEADS, versionCodes: [1, 1600000000] } }),
      patch([op], { id: 'names', appliesTo: { packageName: BLOCKHEADS, versionNames: ['9.9'] } }),
      patch([op], { id: 'hash', appliesTo: { packageName: BLOCKHEADS, sha256: ['a'.repeat(64)] } }),
      patch([op], { id: 'other', appliesTo: { packageName: 'com.example.other' } }),
      patch([op], { id: 'inherit' }),
    ], { appliesTo: { packageName: BLOCKHEADS, versionNames: ['1.7.4'] } }));
    expect(p.patches.find((x) => x.id.endsWith('/gap'))!.appliesTo.versionCode).toEqual({ min: 1, max: 1600000000 });
    const a = await apk();
    expect(run(a, [p]).status).toEqual({ 'pack:demo/codes': 'applied', 'pack:demo/gap': 'incompatible', 'pack:demo/names': 'incompatible', 'pack:demo/hash': 'incompatible', 'pack:demo/other': 'incompatible', 'pack:demo/inherit': 'applied' });
    const hashed = ok(base([patch([op], { appliesTo: { packageName: BLOCKHEADS, sha256: [a.info.sha256] } })], { id: 'h' }));
    expect(run(a, [hashed]).status[packPatchId('h', 'p')]).toBe('applied');
    const noCode = await apk([], { versionCode: null });
    expect(run(noCode, [p]).status['pack:demo/codes']).toBe('incompatible');
  });

  it('applies operations in order and skips those already in effect', async () => {
    const p = one([
      { op: 'manifest.set', target: 'application', attr: 'largeHeap', value: true },
      { op: 'file.add', path: 'assets/a.txt', from: 'a' },
    ], { a: enc.encode('a') });
    const a = await apk([{ name: 'assets/a.txt', data: enc.encode('a') }]);
    const logs: string[] = [];
    p.patches[0]!.apply({ ...ctxOf(a), log: (m) => logs.push(m) });
    expect(logs).toEqual(['pack:demo/p: applied 2 operation(s)']);
    expect(getAttr(application(a), 'largeHeap', ANDROID_NS, 0x0101035a)!.data >>> 0).toBe(0xffffffff);
    expect(() => p.patches[0]!.apply(ctxOf(a))).toThrow(/status: applied\)/);
  });
});

describe('registry with packs', () => {
  const asset = (id: string, path: string, more: Json[] = []) =>
    ok(base([patch([{ op: 'file.add', path, from: 'x' }, ...more])], { id }), { x: enc.encode(id) });

  it('lists built-ins first, then pack patches; skips duplicate packs; reports conflicts', () => {
    const a = asset('one', 'assets/x.txt', [{ op: 'plist.set', path: 'assets/Info.plist', key: 'K', value: 1 }]);
    const b = asset('two', 'assets/x.txt');
    const c = ok(base([patch([{ op: 'plist.set', path: 'assets/Info.plist', key: 'K', value: 2 }]), patch([{ op: 'file.replace', path: 'assets/Info.plist', from: 'y' }], { id: 'q' })], { id: 'three' }), { y: enc.encode('y') });
    const r = registryWithPacks([a, b, asset('one', 'assets/y.txt'), c]);
    const ids = r.registry.list().map((p) => p.id);
    expect(ids.slice(0, defaultRegistry.list().length)).toEqual(defaultRegistry.list().map((p) => p.id));
    expect(ids.slice(defaultRegistry.list().length)).toEqual(['pack:one/p', 'pack:two/p', 'pack:three/p', 'pack:three/q']);
    expect(r.skipped).toEqual(['one']);
    expect(r.conflicts).toEqual([
      { a: 'pack:one/p', b: 'pack:two/p', on: 'file:assets/x.txt' },
      { a: 'pack:one/p', b: 'pack:three/p', on: 'plist:assets/Info.plist#K' },
      { a: 'pack:one/p', b: 'pack:three/q', on: 'plist:assets/Info.plist#K' },
      { a: 'pack:three/p', b: 'pack:three/q', on: 'plist:assets/Info.plist#K' },
    ]);
    expect(defaultRegistry.get('pack:one/p')).toBeUndefined();
    expect(registryWithPacks([]).registry.list()).toHaveLength(defaultRegistry.list().length);
  });

  it('patches a full APK end to end with a pack', async () => {
    const p = one([
      { op: 'file.add', path: 'assets/hello.txt', from: 'hello.txt' },
      { op: 'manifest.set', target: 'application', attr: 'label', value: 'Patched' },
    ], { 'hello.txt': enc.encode('hello from a pack') });
    const { registry } = registryWithPacks([p]);
    const out = await patchApk(makeApk(), { patchIds: [PID], keystore: new MemoryKeystore(), registry });
    expect(out.applied).toEqual([PID]);
    const z = readZip(out.bytes);
    expect(dec.decode(getEntry(z, 'assets/hello.txt')!.data)).toBe('hello from a pack');
    const again = await loadApk(out.bytes);
    expect(getAttr(application(again), 'label', ANDROID_NS, 0x01010001)!.stringValue).toBe('Patched');
    expect(listPatches(again, registry).find((x) => x.patch.id === PID)!.status).toBe('applied');
  });
});
