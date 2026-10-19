import { describe, it, expect } from 'vitest';
import { DexFile, validateDex } from '../../src/dex';
import { calleeOf, insnsOf } from '../../src/patches/dex-support';
import { CURSOR_HIDE_MS, GAMEPAD_CLASS, GAMEPAD_DEADZONE, PatchError, WINDOW_DIALOG_CLASS, defaultRegistry, gamepadControls, type PatchContext } from '../../src';
import { parseAxml } from '../../src/axml';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { build } from '../axml-builder';
import { buildDex, type ClsSpec, type MSpec, type Unit } from './fixture';

const KEY = 'Landroid/view/KeyEvent;', MOTION = 'Landroid/view/MotionEvent;', DIALOG = 'Landroid/app/Dialog;';
const RET0: Unit[] = [0x0012, 0x000f]; // const/4 v0, 0; return v0

function apkCtx(files: Record<string, Uint8Array>): PatchContext & { logs: string[] } {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  const manifest = parseAxml(build({ name: 'manifest', attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }], children: [{ name: 'application' }] }));
  return { zip, manifest, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty() {}, log: (m) => logs.push(m), logs };
}

const method = (name: string, param: string, over: Partial<MSpec> = {}, insns: Unit[] = RET0, regs = 4): MSpec =>
  ({ name, ret: 'Z', params: [param], flags: 1, code: { regs, ins: 2, outs: 0, insns }, ...over });
const keyM = (over: Partial<MSpec> = {}, insns?: Unit[], regs?: number) => method('dispatchKeyEvent', KEY, over, insns, regs);
const motionM = (over: Partial<MSpec> = {}, insns?: Unit[], regs?: number) => method('onGenericMotionEvent', MOTION, over, insns, regs);
const dialog = (virtual: MSpec[] = [keyM(), motionM()], direct: MSpec[] = []): ClsSpec => ({ name: WINDOW_DIALOG_CLASS, super: DIALOG, virtual, direct });
const call = (name: string, param: string): Unit[] => [0x2071, { m: [GAMEPAD_CLASS, name, 'Z', [DIALOG, param]] }, 0x0032];
const stub: ClsSpec = { name: GAMEPAD_CLASS, super: 'Ljava/lang/Object;', direct: [{ name: 'onKey', ret: 'Z', params: [DIALOG, KEY], flags: 9, code: { regs: 3, ins: 2, outs: 0, insns: RET0 } }] };
const dexOf = (ctx: PatchContext, name = 'classes.dex'): DexFile => DexFile.parse(getEntry(ctx.zip, name)!.data);
const callees = (d: DexFile, cls: string, name: string): string[] => {
  const c = d.findClass(cls)!;
  return insnsOf(c, c.findMethod(name)!).map((i) => calleeOf(d, i)).filter(Boolean).map((x) => `${x!.cls}.${x!.name}`);
};

describe('gamepad-controls', () => {
  it('is registered as an opt-in patch for every game version', () => {
    expect(defaultRegistry.get('gamepad-controls')).toBe(gamepadControls);
    expect(gamepadControls.optIn).toBe(true);
    expect(gamepadControls.appliesTo).toEqual({ packageName: 'com.noodlecake.blockheads' });
    expect(gamepadControls.nameKey).toBe('patch.gamepad-controls.name');
    expect(gamepadControls.descriptionKey).toBe('patch.gamepad-controls.description');
    expect(GAMEPAD_DEADZONE).toBe(0.2);
    expect(CURSOR_HIDE_MS).toBe(3000);
  });

  it('adds Gamepad next to the dialog and hooks the start of both input methods, once', () => {
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [] }), 'classes2.dex': buildDex({ classes: [dialog()] }) });
    expect(gamepadControls.detect(c)).toBe('notApplied');
    gamepadControls.apply(c);
    expect(c.logs[0]).toContain('gamepad-controls');
    expect(gamepadControls.detect(c)).toBe('applied');
    expect(() => gamepadControls.apply(c)).toThrow(/status: applied/);
    for (const n of ['classes.dex', 'classes2.dex']) expect(validateDex(getEntry(c.zip, n)!.data)).toEqual([]);
    expect(dexOf(c).findClass(GAMEPAD_CLASS)).toBeUndefined();

    const d = dexOf(c, 'classes2.dex');
    const g = d.findClass(GAMEPAD_CLASS)!;
    expect(g.interfaces).toEqual(['Ljava/lang/Runnable;', 'Landroid/hardware/input/InputManager$InputDeviceListener;']);
    const names = g.methods().map((x) => `${x.direct ? 'd' : 'v'}:${x.name}`).sort();
    expect(names).toEqual([
      'd:<init>', 'd:attach', 'd:axis', 'd:back', 'd:clamp', 'd:key', 'd:motion', 'd:onKey', 'd:onMotion', 'd:pinchStep', 'd:place',
      'd:release', 'd:send', 'd:tick', 'd:touch', 'd:wake', 'v:onInputDeviceAdded', 'v:onInputDeviceChanged', 'v:onInputDeviceRemoved', 'v:run',
    ]);
    expect(g.methods().every((x) => x.hasCode)).toBe(true);

    // The entry points are guarded by a Throwable handler and log through Log.w.
    for (const [entry, inner] of [['onKey', 'key'], ['onMotion', 'motion']] as const) {
      const code = g.codeOf(g.findMethod(entry)!)!;
      expect(code.tries).toHaveLength(1);
      expect(d.typeName(code.handlers[0]!.catches[0]!.type)).toBe('Ljava/lang/Throwable;');
      expect(callees(d, GAMEPAD_CLASS, entry)).toEqual([`${GAMEPAD_CLASS}.${inner}`, 'Landroid/util/Log;.w']);
    }
    for (const n of ['run', 'onInputDeviceRemoved']) expect(g.codeOf(g.findMethod(n)!)!.tries).toHaveLength(1);

    // Synthetic touches: one MotionEvent.obtain(...) with pointer arrays, dispatched into the dialog, then recycled.
    expect(callees(d, GAMEPAD_CLASS, 'send')).toEqual([
      'Landroid/os/SystemClock;.uptimeMillis', 'Landroid/view/MotionEvent$PointerProperties;.<init>', 'Landroid/view/MotionEvent$PointerCoords;.<init>',
      'Landroid/view/MotionEvent;.obtain', 'Landroid/app/Dialog;.dispatchTouchEvent', 'Landroid/view/MotionEvent;.recycle',
    ]);
    const send = insnsOf(g, g.findMethod('send')!);
    expect(send.find((i) => i.name === 'invoke-static/range')).toBeDefined();
    // Back: a source-less KEYCODE_BACK key event re-dispatched into the dialog (so the hook lets it through).
    expect(callees(d, GAMEPAD_CLASS, 'back')).toEqual(['Landroid/os/SystemClock;.uptimeMillis', 'Landroid/view/KeyEvent;.<init>', 'Landroid/app/Dialog;.dispatchKeyEvent']);
    // Hot-plug listener and cursor overlay.
    expect(callees(d, GAMEPAD_CLASS, 'attach')).toEqual(expect.arrayContaining([
      'Landroid/hardware/input/InputManager;.registerInputDeviceListener', 'Landroid/view/Window;.getDecorView', 'Landroid/view/ViewGroup;.addView',
      'Landroid/graphics/drawable/GradientDrawable;.setStroke',
    ]));
    // Mapped key codes: A, B, Start, L1, R1, Y, R3, d-pad range.
    const lits = insnsOf(g, g.findMethod('key')!).filter((i) => i.name === 'const/16').map((i) => i.operands[1]);
    expect(new Set(lits)).toEqual(new Set([96, 97, 108, 102, 103, 100, 107, 19, 20, 21, 22]));
    // Joystick axes read: X, Y, Z, RZ, HAT_X, HAT_Y.
    expect(insnsOf(g, g.findMethod('motion')!).filter((i) => i.name === 'const/16').map((i) => i.operands[1])).toEqual([0, 1, 11, 14, 15, 16]);

    // Both dialog methods start with `if (Gamepad.onX(this, e)) return true;` followed by the original body.
    const dl = d.findClass(WINDOW_DIALOG_CLASS)!;
    for (const [name, param, entry] of [['dispatchKeyEvent', KEY, 'onKey'], ['onGenericMotionEvent', MOTION, 'onMotion']] as const) {
      const body = insnsOf(dl, dl.findMethod(name, [param], 'Z')!);
      expect(calleeOf(d, body[0]!)).toMatchObject({ cls: GAMEPAD_CLASS, name: entry, params: [DIALOG, param] });
      expect(body.map((i) => i.name)).toEqual(['invoke-static', 'move-result', 'if-eqz', 'return', 'nop', 'const/4', 'return']);
    }
  });

  it('completes partial states without adding a second class', () => {
    const classOnly = apkCtx({ 'classes.dex': buildDex({ classes: [dialog(), stub] }) });
    expect(gamepadControls.detect(classOnly)).toBe('notApplied');
    gamepadControls.apply(classOnly);
    expect(gamepadControls.detect(classOnly)).toBe('applied');
    expect(dexOf(classOnly).classNames().filter((n) => n === GAMEPAD_CLASS)).toHaveLength(1);
    expect(dexOf(classOnly).findClass(GAMEPAD_CLASS)!.findMethod('tick')).toBeUndefined();

    const keyHooked = apkCtx({ 'classes.dex': buildDex({ classes: [dialog([keyM({}, [...call('onKey', KEY), ...RET0]), motionM()])] }) });
    expect(gamepadControls.detect(keyHooked)).toBe('notApplied');
    gamepadControls.apply(keyHooked);
    expect(gamepadControls.detect(keyHooked)).toBe('applied');
    const d = dexOf(keyHooked), dl = d.findClass(WINDOW_DIALOG_CLASS)!;
    expect(insnsOf(dl, dl.findMethod('dispatchKeyEvent')!).filter((i) => calleeOf(d, i)?.cls === GAMEPAD_CLASS)).toHaveLength(1);
    expect(insnsOf(dl, dl.findMethod('onGenericMotionEvent')!).filter((i) => calleeOf(d, i)?.cls === GAMEPAD_CLASS)).toHaveLength(1);
    expect(d.findClass(GAMEPAD_CLASS)!.findMethod('tick')).toBeDefined();

    const motionHooked = apkCtx({ 'classes.dex': buildDex({ classes: [dialog([keyM(), motionM({}, [...call('onMotion', MOTION), ...RET0])]), stub] }) });
    expect(gamepadControls.detect(motionHooked)).toBe('notApplied');
    gamepadControls.apply(motionHooked);
    expect(gamepadControls.detect(motionHooked)).toBe('applied');
  });

  it('is incompatible without the dialog or usable input methods', () => {
    const ctx = (cls: ClsSpec[]) => apkCtx({ 'classes.dex': buildDex({ classes: cls }) });
    expect(gamepadControls.detect(apkCtx({}))).toBe('incompatible');
    expect(gamepadControls.detect(ctx([]))).toBe('incompatible');
    expect(gamepadControls.detect(ctx([dialog([keyM()])]))).toBe('incompatible');
    expect(gamepadControls.detect(ctx([dialog([motionM()])]))).toBe('incompatible');
    // No spare register below the two arguments.
    expect(gamepadControls.detect(ctx([dialog([keyM({}, RET0, 2), motionM()])]))).toBe('incompatible');
    expect(gamepadControls.detect(ctx([dialog([keyM(), motionM({}, RET0, 2)])]))).toBe('incompatible');
    // Direct (private) or code-less methods are not the overrides the framework calls.
    expect(gamepadControls.detect(ctx([dialog([keyM()], [motionM({ flags: 2 })])]))).toBe('incompatible');
    const abstractKey = keyM({ flags: 0x401 });
    delete abstractKey.code;
    expect(gamepadControls.detect(ctx([dialog([abstractKey, motionM()])]))).toBe('incompatible');
    expect(() => gamepadControls.apply(apkCtx({}))).toThrow(PatchError);
  });
});
