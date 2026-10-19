import { ACC, CodeBuilder, type DexClass, type DexFile, type DexSet, type MethodInfo } from '../dex';
import { callsClass, editDex, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const GAMEPAD_CLASS = 'Lcom/blockheadsclub/patch/Gamepad;';
/** The dialog that holds the game's UIWindow; all game input arrives there, on Apportable's own UI thread. */
export const WINDOW_DIALOG_CLASS = 'Lcom/apportable/ui/Window$WindowDialog;';
/** Stick deflection below which an axis counts as centred. */
export const GAMEPAD_DEADZONE = 0.2;
/** Milliseconds without controller input after which the cursor hides. */
export const CURSOR_HIDE_MS = 3000;

const G = GAMEPAD_CLASS;
const OBJ = 'Ljava/lang/Object;', STR = 'Ljava/lang/String;', THROWABLE = 'Ljava/lang/Throwable;', RUNNABLE = 'Ljava/lang/Runnable;';
const DIALOG = 'Landroid/app/Dialog;', CONTEXT = 'Landroid/content/Context;', KEY = 'Landroid/view/KeyEvent;', MOTION = 'Landroid/view/MotionEvent;';
const VIEW = 'Landroid/view/View;', GROUP = 'Landroid/view/ViewGroup;', WINDOW = 'Landroid/view/Window;', SYSCLOCK = 'Landroid/os/SystemClock;';
const INPUT = 'Landroid/hardware/input/InputManager;', LISTENER = 'Landroid/hardware/input/InputManager$InputDeviceListener;';
const PROPS = 'Landroid/view/MotionEvent$PointerProperties;', COORDS = 'Landroid/view/MotionEvent$PointerCoords;';
const SHAPE = 'Landroid/graphics/drawable/GradientDrawable;', LP = 'Landroid/widget/FrameLayout$LayoutParams;';
const F = 'F', I = 'I', Z = 'Z', J = 'J', V = 'V';

/** Raw bits of a float literal (for `const`). */
const fbits = (v: number): number => new Int32Array(new Float32Array([v]).buffer)[0]!;
/** High 16 bits of a float literal whose low 16 bits are zero (for `const/high16`). */
const fhigh = (v: number): number => fbits(v) >> 16;

/** Static fields of Gamepad: name -> type. All state is static; the single instance only serves as Runnable/listener. */
const FIELDS: Record<string, string> = {
  inst: G, dialog: DIALOG, root: GROUP, cursor: VIEW, size: I,
  cx: F, cy: F, lx: F, ly: F, rx: F, ry: F, hx: F, hy: F, kx: F, ky: F, wx: F, wy: F,
  a: Z, aWant: Z, aHit: Z, walk: Z, ticking: Z, pinchIn: Z, pinch: I, zoom: I, cycle: I, down: J, last: J, tickAt: J,
};

// Android constants used below.
const SRC_PAD_KEY = 0x01000400; // SOURCE_GAMEPAD | SOURCE_JOYSTICK specific bits
const SRC_JOYSTICK = 0x01000010;
const SRC_TOUCHSCREEN = 0x1002;
const K = { A: 96, B: 97, Y: 100, L1: 102, R1: 103, R3: 107, START: 108, UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, BACK: 4 };
const AXIS = { X: 0, Y: 1, Z: 11, RZ: 14, HAT_X: 15, HAT_Y: 16 };
const ACT = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3, POINTER1_DOWN: 0x105, POINTER1_UP: 0x106 };
/** Cursor speed per 16 ms at full deflection, as a fraction of the shorter screen side (scaled by the real frame time). */
const CURSOR_SPEED = 0.02;
/** Distance of the walk touch from its anchor at full deflection (fraction of the shorter side). */
const WALK_REACH = 0.3;
/**
 * Height of the walk anchor (fraction of the screen height). The followed blockhead stands with its centre at about 0.48;
 * 0.44 is head height, so on flat ground the held touch is in the air beside the blockhead (a touch on a block digs it).
 */
const WALK_Y = 0.44;
/** Pinch half-distances (fraction of the shorter side): zoom in spreads 0.10 -> 0.18, zoom out closes 0.18 -> 0.10. */
const PINCH_NEAR = 0.1, PINCH_FAR = 0.18;

/**
 * Adds `Gamepad` (implements Runnable and InputManager.InputDeviceListener; all state static):
 * - `onKey(Dialog, KeyEvent)Z` / `onMotion(Dialog, MotionEvent)Z`: called first by the game dialog's `dispatchKeyEvent` and
 *   `onGenericMotionEvent`; handle gamepad/joystick input only, return true when consumed, never throw.
 * - `attach(Dialog)`: once per dialog adds the cursor (a 28 dp ring) to its decor view; registers the hot-plug listener once.
 * - `run()` / `tick()`: every 16 ms while input is active: moves the cursor and plays at most one touch transition per frame
 *   (pinch > A touch > walk touch), so injected gestures never overlap. Hides the cursor after CURSOR_HIDE_MS idle.
 * - `send(action, count, x, y, dx)`: dispatches a synthetic touchscreen MotionEvent with `count` pointers at (x + i*dx, y)
 *   to the dialog, i.e. through the same view path as a real touch.
 */
function addGamepad(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const cls = dex.addClass({ descriptor: G, access: ACC.PUBLIC | ACC.FINAL, interfaces: [RUNNABLE, LISTENER], sourceFile: 'Gamepad.java' });
  const f: Record<string, number> = {};
  for (const [name, type] of Object.entries(FIELDS)) f[name] = cls.addStaticField(name, type, ACC.PRIVATE);
  const fld = (n: string): number => f[n]!;
  const own = (name: string, ret: string, ...params: string[]): number => m(G, name, ret, ...params);
  const tag = dex.string('BlockheadsPatcher');
  const throwable = dex.type(THROWABLE);
  const uptime = m(SYSCLOCK, 'uptimeMillis', J);
  const logW = m('Landroid/util/Log;', 'w', I, STR, STR, THROWABLE);
  const add = (name: string, ret: string, params: string[], access: number, code: CodeBuilder): void => {
    cls.addMethod({ name, returnType: ret, params, access, code });
  };
  const S = ACC.PRIVATE | ACC.STATIC;

  add('<init>', V, [], ACC.PUBLIC | ACC.CONSTRUCTOR, new CodeBuilder({ registers: 1, outs: 1 }).op('invoke-direct', m(OBJ, '<init>', V), 0).op('return-void'));

  // Guarded entry points: v0 result/exception, v1 tag, v2 message, v3/v4 arguments.
  const guarded = (name: string, inner: string, param: string, msg: string): void => {
    add(name, Z, [DIALOG, param], ACC.PUBLIC | ACC.STATIC, new CodeBuilder({ registers: 5, outs: 3 })
      .label('try').op('invoke-static', own(inner, Z, DIALOG, param), 3, 4).op('move-result', 0).label('end')
      .op('return', 0)
      .label('catch').op('move-exception', 0).op('const-string', 1, tag).op('const-string', 2, dex.string(msg))
      .op('invoke-static', logW, 1, 2, 0).op('const/4', 0, 0).op('return', 0)
      .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] }));
  };
  guarded('onKey', 'key', KEY, 'gamepad key handling failed');
  guarded('onMotion', 'motion', MOTION, 'gamepad motion handling failed');

  // key(Dialog d = v6, KeyEvent e = v7): v0 code, v1 action / value, v2 repeat, v3 down, v4 first press, v5 temp.
  const key = new CodeBuilder({ registers: 8, outs: 3 })
    .op('invoke-virtual', m(KEY, 'getSource', I), 7).op('move-result', 0)
    .op('const', 1, SRC_PAD_KEY).op('and-int', 0, 0, 1).op('if-eqz', 0, 'no')
    .op('invoke-virtual', m(KEY, 'getKeyCode', I), 7).op('move-result', 0)
    .op('const/16', 5, K.A).op('if-eq', 0, 5, 'mapped')
    .op('const/16', 5, K.B).op('if-eq', 0, 5, 'mapped')
    .op('const/16', 5, K.START).op('if-eq', 0, 5, 'mapped')
    .op('const/16', 5, K.L1).op('if-eq', 0, 5, 'mapped')
    .op('const/16', 5, K.R1).op('if-eq', 0, 5, 'mapped')
    .op('const/16', 5, K.Y).op('if-eq', 0, 5, 'mapped')
    .op('const/16', 5, K.R3).op('if-eq', 0, 5, 'mapped')
    .op('const/16', 5, K.UP).op('if-lt', 0, 5, 'no')
    .op('const/16', 5, K.RIGHT).op('if-gt', 0, 5, 'no')
    .label('mapped')
    .op('invoke-static', own('attach', V, DIALOG), 6)
    .op('invoke-virtual', m(KEY, 'getAction', I), 7).op('move-result', 1)
    .op('invoke-virtual', m(KEY, 'getRepeatCount', I), 7).op('move-result', 2)
    .op('const/4', 3, 1).op('if-eqz', 1, 'isDown').op('const/4', 3, 0).label('isDown')
    .op('const/4', 4, 0).op('if-eqz', 3, 'notFirst').op('if-nez', 2, 'notFirst').op('const/4', 4, 1).label('notFirst')
    // A: hold = touch held at the cursor; a press is latched so a quick tap is not lost between frames.
    .op('const/16', 5, K.A).op('if-ne', 0, 5, 'notA')
    .op('sput-boolean', 3, fld('aWant')).op('if-eqz', 4, 'done').op('const/4', 5, 1).op('sput-boolean', 5, fld('aHit')).op('goto/16', 'done')
    .label('notA')
    // B and Start: the game's back key (opens/closes the pause menu, closes dialogs).
    .op('const/16', 5, K.B).op('if-eq', 0, 5, 'back')
    .op('const/16', 5, K.START).op('if-ne', 0, 5, 'notBack')
    .label('back').op('if-nez', 2, 'done').op('invoke-static', own('back', V, Z), 3).op('goto/16', 'done')
    .label('notBack')
    .op('const/16', 5, K.L1).op('if-ne', 0, 5, 'notL1').op('if-eqz', 4, 'done').op('const/4', 5, -1).op('goto/16', 'zoom')
    .label('notL1')
    .op('const/16', 5, K.R1).op('if-ne', 0, 5, 'notR1').op('if-eqz', 4, 'done').op('const/4', 5, 1).op('goto/16', 'zoom')
    .label('notR1')
    .op('const/16', 5, K.Y).op('if-eq', 0, 5, 'cycle')
    .op('const/16', 5, K.R3).op('if-ne', 0, 5, 'dpad')
    // Y / R3: cycle three zoom levels (two steps in, two steps in, four steps out).
    .label('cycle').op('if-eqz', 4, 'done')
    .op('sget', 5, fld('cycle')).op('const/4', 1, 2).op('if-ge', 5, 1, 'cycleOut')
    .op('add-int/lit8', 5, 5, 1).op('sput', 5, fld('cycle')).op('const/4', 5, 2).op('goto/16', 'zoom')
    .label('cycleOut').op('const/4', 5, 0).op('sput', 5, fld('cycle')).op('const/4', 5, -4)
    .label('zoom').op('sget', 1, fld('zoom')).op('add-int', 1, 1, 5).op('sput', 1, fld('zoom')).op('goto/16', 'done')
    // D-pad keys (19..22): move the cursor while held.
    .label('dpad')
    .op('const/4', 1, 0).op('if-eqz', 3, 'value').op('const/high16', 1, fhigh(1)).label('value')
    .op('const/16', 5, K.UP).op('if-ne', 0, 5, 'notUp').op('neg-float', 1, 1).op('sput', 1, fld('ky')).op('goto/16', 'done')
    .label('notUp').op('const/16', 5, K.DOWN).op('if-ne', 0, 5, 'notDown').op('sput', 1, fld('ky')).op('goto/16', 'done')
    .label('notDown').op('const/16', 5, K.LEFT).op('if-ne', 0, 5, 'right').op('neg-float', 1, 1).op('sput', 1, fld('kx')).op('goto/16', 'done')
    .label('right').op('sput', 1, fld('kx'))
    .label('done').op('invoke-static', own('wake', V)).op('const/4', 0, 1).op('return', 0)
    .label('no').op('const/4', 0, 0).op('return', 0);
  add('key', Z, [DIALOG, KEY], S, key);

  // axis(MotionEvent e = v3, int axis = v4)F: the axis value, 0 inside the deadzone.
  add('axis', F, [MOTION, I], S, new CodeBuilder({ registers: 5, outs: 2 })
    .op('invoke-virtual', m(MOTION, 'getAxisValue', F, I), 3, 4).op('move-result', 0)
    .op('invoke-static', m('Ljava/lang/Math;', 'abs', F, F), 0).op('move-result', 1)
    .op('const', 2, fbits(GAMEPAD_DEADZONE)).op('cmpl-float', 1, 1, 2).op('if-gez', 1, 'keep').op('const/4', 0, 0)
    .label('keep').op('return', 0));

  // motion(Dialog d = v3, MotionEvent e = v4): joystick ACTION_MOVE only.
  const motion = new CodeBuilder({ registers: 5, outs: 2 })
    .op('invoke-virtual', m(MOTION, 'getSource', I), 4).op('move-result', 0)
    .op('const', 1, SRC_JOYSTICK).op('and-int', 0, 0, 1).op('if-ne', 0, 1, 'no')
    .op('invoke-virtual', m(MOTION, 'getAction', I), 4).op('move-result', 0)
    .op('const/4', 1, ACT.MOVE).op('if-ne', 0, 1, 'no')
    .op('invoke-static', own('attach', V, DIALOG), 3);
  for (const [axis, field] of [[AXIS.X, 'lx'], [AXIS.Y, 'ly'], [AXIS.Z, 'rx'], [AXIS.RZ, 'ry'], [AXIS.HAT_X, 'hx'], [AXIS.HAT_Y, 'hy']] as const) {
    motion.op('const/16', 1, axis).op('invoke-static', own('axis', F, MOTION, I), 4, 1).op('move-result', 0).op('sput', 0, fld(field));
  }
  motion.op('invoke-static', own('wake', V)).op('const/4', 0, 1).op('return', 0)
    .label('no').op('const/4', 0, 0).op('return', 0);
  add('motion', Z, [DIALOG, MOTION], S, motion);

  // attach(Dialog d = v8): v0..v7 temps.
  add('attach', V, [DIALOG], S, new CodeBuilder({ registers: 9, outs: 3 })
    .op('sget-object', 0, fld('inst')).op('if-nez', 0, 'haveInst')
    .op('new-instance', 0, dex.type(G)).op('invoke-direct', own('<init>', V), 0).op('sput-object', 0, fld('inst'))
    .op('invoke-virtual', m(DIALOG, 'getContext', CONTEXT), 8).op('move-result-object', 1)
    .op('const-string', 2, dex.string('input')).op('invoke-virtual', m(CONTEXT, 'getSystemService', OBJ, STR), 1, 2).op('move-result-object', 1)
    .op('check-cast', 1, dex.type(INPUT)).op('const/4', 2, 0)
    .op('invoke-virtual', m(INPUT, 'registerInputDeviceListener', V, LISTENER, 'Landroid/os/Handler;'), 1, 0, 2)
    .label('haveInst')
    .op('sget-object', 0, fld('dialog')).op('if-ne', 0, 8, 'fresh').op('return-void')
    .label('fresh')
    .op('sget-object', 0, fld('cursor')).op('if-eqz', 0, 'noOld')
    .op('invoke-virtual', m(VIEW, 'getParent', 'Landroid/view/ViewParent;'), 0).op('move-result-object', 1)
    .op('instance-of', 2, 1, dex.type(GROUP)).op('if-eqz', 2, 'noOld')
    .op('check-cast', 1, dex.type(GROUP)).op('invoke-virtual', m(GROUP, 'removeView', V, VIEW), 1, 0)
    .label('noOld')
    .op('sput-object', 8, fld('dialog'))
    .op('invoke-virtual', m(DIALOG, 'getWindow', WINDOW), 8).op('move-result-object', 0)
    .op('invoke-virtual', m(WINDOW, 'getDecorView', VIEW), 0).op('move-result-object', 0)
    .op('check-cast', 0, dex.type(GROUP)).op('sput-object', 0, fld('root'))
    .op('invoke-virtual', m(DIALOG, 'getContext', CONTEXT), 8).op('move-result-object', 1)
    .op('invoke-virtual', m(CONTEXT, 'getResources', 'Landroid/content/res/Resources;'), 1).op('move-result-object', 2)
    .op('invoke-virtual', m('Landroid/content/res/Resources;', 'getDisplayMetrics', 'Landroid/util/DisplayMetrics;'), 2).op('move-result-object', 2)
    .op('iget', 2, 2, dex.field('Landroid/util/DisplayMetrics;', 'density', F))
    .op('const/high16', 3, fhigh(28)).op('mul-float', 3, 3, 2).op('float-to-int', 3, 3).op('sput', 3, fld('size'))
    .op('const/high16', 4, fhigh(3)).op('mul-float', 4, 4, 2).op('float-to-int', 4, 4)
    .op('new-instance', 5, dex.type(SHAPE)).op('invoke-direct', m(SHAPE, '<init>', V), 5)
    .op('const/4', 6, 1).op('invoke-virtual', m(SHAPE, 'setShape', V, I), 5, 6)
    .op('const/high16', 6, 0x4000).op('invoke-virtual', m(SHAPE, 'setColor', V, I), 5, 6)
    .op('const/4', 6, -1).op('invoke-virtual', m(SHAPE, 'setStroke', V, I, I), 5, 4, 6)
    .op('new-instance', 6, dex.type(VIEW)).op('invoke-direct', m(VIEW, '<init>', V, CONTEXT), 6, 1)
    .op('invoke-virtual', m(VIEW, 'setBackground', V, 'Landroid/graphics/drawable/Drawable;'), 6, 5)
    .op('const/4', 7, 4).op('invoke-virtual', m(VIEW, 'setVisibility', V, I), 6, 7)
    .op('sput-object', 6, fld('cursor'))
    .op('new-instance', 7, dex.type(LP)).op('invoke-direct', m(LP, '<init>', V, I, I), 7, 3, 3)
    .op('invoke-virtual', m(GROUP, 'addView', V, VIEW, 'Landroid/view/ViewGroup$LayoutParams;'), 0, 6, 7)
    .op('const/high16', 1, fhigh(-1)).op('sput', 1, fld('cx'))
    .op('return-void'));

  // wake(): v0/v1 now, v2..v5 temps.
  add('wake', V, [], S, new CodeBuilder({ registers: 6, outs: 4 })
    .op('invoke-static', uptime).op('move-result-wide', 0).op('sput-wide', 0, fld('last'))
    .op('sget-object', 2, fld('cursor')).op('if-eqz', 2, 'r').op('const/4', 3, 0).op('invoke-virtual', m(VIEW, 'setVisibility', V, I), 2, 3)
    .op('sget-boolean', 3, fld('ticking')).op('if-nez', 3, 'r')
    .op('sget-object', 2, fld('root')).op('if-eqz', 2, 'r')
    .op('const/4', 3, 1).op('sput-boolean', 3, fld('ticking')).op('sput-wide', 0, fld('tickAt'))
    .op('sget-object', 3, fld('inst')).op('const-wide/16', 4, 16)
    .op('invoke-virtual', m(VIEW, 'postDelayed', Z, RUNNABLE, J), 2, 3, 4, 5)
    .label('r').op('return-void'));

  // run() (this = v3): tick() guarded; on failure stop ticking and log.
  add('run', V, [], ACC.PUBLIC, new CodeBuilder({ registers: 4, outs: 3 })
    .label('try').op('invoke-static', own('tick', V)).label('end').op('return-void')
    .label('catch').op('move-exception', 0).op('const/4', 1, 0).op('sput-boolean', 1, fld('ticking'))
    .op('const-string', 1, tag).op('const-string', 2, dex.string('gamepad tick failed')).op('invoke-static', logW, 1, 2, 0).op('return-void')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] }));

  // Hot-plug: a removed device releases every injected touch and resets the stick state.
  add('onInputDeviceAdded', V, [I], ACC.PUBLIC, new CodeBuilder({ registers: 2 }).op('return-void'));
  add('onInputDeviceChanged', V, [I], ACC.PUBLIC, new CodeBuilder({ registers: 2 }).op('return-void'));
  add('onInputDeviceRemoved', V, [I], ACC.PUBLIC, new CodeBuilder({ registers: 3 })
    .label('try').op('invoke-static', own('release', V)).label('end').op('return-void')
    .label('catch').op('move-exception', 0).op('return-void')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] }));
  const release = new CodeBuilder({ registers: 3, outs: 3 })
    .op('sget-boolean', 0, fld('a')).op('sget-boolean', 1, fld('walk')).op('or-int', 0, 0, 1).op('sget', 1, fld('pinch')).op('or-int', 0, 0, 1)
    .op('if-eqz', 0, 'clear')
    .op('const/4', 0, ACT.CANCEL).op('sget', 1, fld('cx')).op('sget', 2, fld('cy')).op('invoke-static', own('touch', V, I, F, F), 0, 1, 2)
    .label('clear').op('const/4', 0, 0);
  for (const n of ['a', 'aWant', 'aHit', 'walk']) release.op('sput-boolean', 0, fld(n));
  for (const n of ['pinch', 'zoom', 'lx', 'ly', 'rx', 'ry', 'hx', 'hy', 'kx', 'ky']) release.op('sput', 0, fld(n));
  add('release', V, [], S, release.op('return-void'));

  // back(boolean down = v9): dispatches KEYCODE_BACK (source 0, so onKey lets it through) to the dialog.
  add('back', V, [Z], S, new CodeBuilder({ registers: 10, outs: 8 })
    .op('sget-object', 0, fld('dialog')).op('if-eqz', 0, 'r')
    .op('invoke-static', uptime).op('move-result-wide', 2).op('move-wide', 4, 2)
    .op('xor-int/lit8', 6, 9, 1).op('const/4', 7, K.BACK).op('const/4', 8, 0)
    .op('new-instance', 1, dex.type(KEY)).op('invoke-direct/range', m(KEY, '<init>', V, J, J, I, I, I), 1, 8)
    .op('invoke-virtual', m(DIALOG, 'dispatchKeyEvent', Z, KEY), 0, 1)
    .label('r').op('return-void'));

  // send(action = v32, count = v33, x = v34, y = v35, dx = v36): v0..v15 work registers, v16..v31 the obtain() arguments.
  const send = new CodeBuilder({ registers: 37, outs: 16 })
    .op('move/from16', 10, 32).op('move/from16', 11, 33).op('move/from16', 12, 34).op('move/from16', 13, 35).op('move/from16', 14, 36)
    .op('invoke-static', uptime).op('move-result-wide', 0)
    .op('if-nez', 10, 'notDown').op('sput-wide', 0, fld('down')).label('notDown')
    .op('new-array', 2, 11, dex.type(`[${PROPS}`)).op('new-array', 3, 11, dex.type(`[${COORDS}`))
    .op('const/4', 4, 0)
    .label('loop').op('if-ge', 4, 11, 'built')
    .op('new-instance', 5, dex.type(PROPS)).op('invoke-direct', m(PROPS, '<init>', V), 5)
    .op('iput', 4, 5, dex.field(PROPS, 'id', I)).op('const/4', 6, 1).op('iput', 6, 5, dex.field(PROPS, 'toolType', I))
    .op('aput-object', 5, 2, 4)
    .op('new-instance', 5, dex.type(COORDS)).op('invoke-direct', m(COORDS, '<init>', V), 5)
    .op('int-to-float', 6, 4).op('mul-float', 6, 6, 14).op('add-float', 6, 6, 12)
    .op('iput', 6, 5, dex.field(COORDS, 'x', F)).op('iput', 13, 5, dex.field(COORDS, 'y', F))
    .op('const/high16', 6, fhigh(1)).op('iput', 6, 5, dex.field(COORDS, 'pressure', F)).op('iput', 6, 5, dex.field(COORDS, 'size', F))
    .op('aput-object', 5, 3, 4)
    .op('add-int/lit8', 4, 4, 1).op('goto', 'loop')
    .label('built')
    .op('sget-wide', 16, fld('down')).op('move-wide/from16', 18, 0).op('move/from16', 20, 10).op('move/from16', 21, 11)
    .op('move-object/from16', 22, 2).op('move-object/from16', 23, 3).op('const/16', 24, 0).op('const/16', 25, 0)
    .op('const/high16', 26, fhigh(1)).op('const/high16', 27, fhigh(1)).op('const/16', 28, 0).op('const/16', 29, 0)
    .op('const/16', 30, SRC_TOUCHSCREEN).op('const/16', 31, 0)
    .op('invoke-static/range', m(MOTION, 'obtain', MOTION, J, J, I, I, `[${PROPS}`, `[${COORDS}`, I, I, F, F, I, I, I, I), 16, 16)
    .op('move-result-object', 5)
    .op('sget-object', 6, fld('dialog')).op('if-eqz', 6, 'recycle')
    .op('invoke-virtual', m(DIALOG, 'dispatchTouchEvent', Z, MOTION), 6, 5)
    .label('recycle').op('invoke-virtual', m(MOTION, 'recycle', V), 5)
    .op('return-void');
  add('send', V, [I, I, F, F, F], S, send);

  // touch(action = v2, x = v3, y = v4): one pointer.
  add('touch', V, [I, F, F], S, new CodeBuilder({ registers: 5, outs: 5 })
    .op('const/4', 0, 1).op('const/4', 1, 0).op('invoke-static', own('send', V, I, I, F, F, F), 2, 0, 3, 4, 1).op('return-void'));

  // clamp(v = v1, max = v2)F: v limited to [0, max - 1].
  add('clamp', F, [F, F], S, new CodeBuilder({ registers: 3 })
    .op('const/4', 0, 0).op('cmpl-float', 0, 1, 0).op('if-gez', 0, 'pos').op('const/4', 1, 0).op('return', 1)
    .label('pos').op('const/high16', 0, fhigh(1)).op('sub-float', 2, 2, 0).op('cmpl-float', 0, 1, 2).op('if-lez', 0, 'ok').op('move', 1, 2)
    .label('ok').op('return', 1));

  // place(): moves the cursor ring so that its centre is at (cx, cy).
  add('place', V, [], S, new CodeBuilder({ registers: 4, outs: 2 })
    .op('sget-object', 0, fld('cursor')).op('if-eqz', 0, 'r')
    .op('sget', 1, fld('size')).op('int-to-float', 1, 1).op('const/high16', 2, fhigh(0.5)).op('mul-float', 1, 1, 2)
    .op('sget', 2, fld('cx')).op('sub-float', 2, 2, 1).op('invoke-virtual', m(VIEW, 'getLeft', I), 0).op('move-result', 3)
    .op('int-to-float', 3, 3).op('sub-float', 2, 2, 3).op('invoke-virtual', m(VIEW, 'setTranslationX', V, F), 0, 2)
    .op('sget', 2, fld('cy')).op('sub-float', 2, 2, 1).op('invoke-virtual', m(VIEW, 'getTop', I), 0).op('move-result', 3)
    .op('int-to-float', 3, 3).op('sub-float', 2, 2, 3).op('invoke-virtual', m(VIEW, 'setTranslationY', V, F), 0, 2)
    .label('r').op('return-void'));

  // pinchStep(w = v10, h = v11, m = v12): frame 1 down, 2 second finger down, 3..8 move, 9 second finger up, 10 up.
  add('pinchStep', V, [F, F, F], S, new CodeBuilder({ registers: 13, outs: 5 })
    .op('sget', 0, fld('pinch'))
    .op('add-int/lit8', 1, 0, -2).op('int-to-float', 1, 1).op('const/high16', 2, fhigh(6)).op('div-float', 1, 1, 2)
    .op('const/4', 2, 0).op('cmpl-float', 3, 1, 2).op('if-gez', 3, 'p0').op('move', 1, 2).label('p0')
    .op('const/high16', 2, fhigh(1)).op('cmpl-float', 3, 1, 2).op('if-lez', 3, 'p1').op('move', 1, 2).label('p1')
    .op('sget-boolean', 3, fld('pinchIn')).op('const', 4, fbits(PINCH_NEAR)).op('const', 5, fbits(PINCH_FAR - PINCH_NEAR))
    .op('if-nez', 3, 'dir').op('const', 4, fbits(PINCH_FAR)).op('neg-float', 5, 5).label('dir')
    .op('mul-float', 5, 5, 1).op('add-float', 4, 4, 5).op('mul-float', 4, 4, 12)
    .op('const/high16', 5, fhigh(0.5)).op('mul-float', 6, 10, 5).op('sub-float', 6, 6, 4).op('mul-float', 7, 11, 5).op('add-float', 8, 4, 4)
    .op('const/4', 2, 1).op('const/4', 9, ACT.DOWN).op('const/4', 3, 1).op('if-eq', 0, 3, 'send')
    .op('const/4', 2, 2).op('const/16', 9, ACT.POINTER1_DOWN).op('const/4', 3, 2).op('if-eq', 0, 3, 'send')
    .op('const/4', 9, ACT.MOVE).op('const/16', 3, 9).op('if-lt', 0, 3, 'send')
    .op('const/16', 9, ACT.POINTER1_UP).op('if-eq', 0, 3, 'send')
    .op('const/4', 2, 1).op('const/4', 9, ACT.UP)
    .label('send').op('invoke-static', own('send', V, I, I, F, F, F), 9, 2, 6, 7, 8)
    .op('add-int/lit8', 0, 0, 1).op('const/16', 3, 11).op('if-lt', 0, 3, 'store').op('const/4', 0, 0)
    .label('store').op('sput', 0, fld('pinch')).op('return-void'));

  // tick(): v0/v1 now, v2 w, v3 h, v4 shorter side, v9 active, v12 walk wanted, v13/v14 walk target, rest temps.
  const tick = new CodeBuilder({ registers: 16, outs: 4 })
    .op('invoke-static', uptime).op('move-result-wide', 0)
    .op('sget-object', 5, fld('root')).op('if-nez', 5, 'hasRoot').op('const/4', 5, 0).op('sput-boolean', 5, fld('ticking')).op('return-void')
    .label('hasRoot')
    .op('invoke-virtual', m(VIEW, 'getWidth', I), 5).op('move-result', 2).op('int-to-float', 2, 2)
    .op('invoke-virtual', m(VIEW, 'getHeight', I), 5).op('move-result', 3).op('int-to-float', 3, 3)
    .op('invoke-static', m('Ljava/lang/Math;', 'min', F, F, F), 2, 3).op('move-result', 4)
    .op('const/4', 9, 0)
    // First frame after attach: cursor to the centre.
    .op('sget', 5, fld('cx')).op('const/4', 6, 0).op('cmpl-float', 7, 5, 6).op('if-gez', 7, 'hasPos')
    .op('const/high16', 6, fhigh(0.5)).op('mul-float', 5, 2, 6).op('sput', 5, fld('cx')).op('mul-float', 5, 3, 6).op('sput', 5, fld('cy'))
    .label('hasPos')
    // Cursor velocity: right stick + hat + d-pad keys.
    .op('sget', 5, fld('rx')).op('sget', 6, fld('hx')).op('add-float', 5, 5, 6).op('sget', 6, fld('kx')).op('add-float', 5, 5, 6)
    .op('sget', 6, fld('ry')).op('sget', 7, fld('hy')).op('add-float', 6, 6, 7).op('sget', 7, fld('ky')).op('add-float', 6, 6, 7)
    // Frame time in 16 ms units (at most 4), so the cursor speed does not depend on how busy the game's thread is.
    .op('sget-wide', 10, fld('tickAt')).op('sub-long', 10, 0, 10).op('sput-wide', 0, fld('tickAt')).op('long-to-float', 10, 10)
    .op('const/high16', 11, fhigh(64)).op('invoke-static', m('Ljava/lang/Math;', 'min', F, F, F), 10, 11).op('move-result', 10)
    .op('const/high16', 11, fhigh(16)).op('div-float', 10, 10, 11)
    .op('const', 7, fbits(CURSOR_SPEED)).op('mul-float', 7, 7, 4).op('mul-float', 7, 7, 10)
    .op('sget', 8, fld('cx')).op('mul-float', 10, 5, 7).op('add-float', 8, 8, 10)
    .op('invoke-static', own('clamp', F, F, F), 8, 2).op('move-result', 8).op('sput', 8, fld('cx'))
    .op('sget', 8, fld('cy')).op('mul-float', 10, 6, 7).op('add-float', 8, 8, 10)
    .op('invoke-static', own('clamp', F, F, F), 8, 3).op('move-result', 8).op('sput', 8, fld('cy'))
    .op('const/4', 10, 0)
    .op('cmpl-float', 11, 5, 10).op('if-eqz', 11, 'vx0').op('const/4', 9, 1).label('vx0')
    .op('cmpl-float', 11, 6, 10).op('if-eqz', 11, 'vy0').op('const/4', 9, 1).label('vy0')
    .op('invoke-static', own('place', V))
    // Walk: wanted while the left stick is deflected; target = (w/2, h*WALK_Y) + stick * reach.
    .op('sget', 5, fld('lx')).op('sget', 6, fld('ly')).op('const/4', 12, 0)
    .op('cmpl-float', 11, 5, 10).op('if-eqz', 11, 'lx0').op('const/4', 12, 1).label('lx0')
    .op('cmpl-float', 11, 6, 10).op('if-eqz', 11, 'ly0').op('const/4', 12, 1).label('ly0')
    .op('if-eqz', 12, 'noWalkWanted').op('const/4', 9, 1).label('noWalkWanted')
    .op('const', 7, fbits(WALK_REACH)).op('mul-float', 7, 7, 4).op('const/high16', 8, fhigh(0.5))
    .op('mul-float', 13, 2, 8).op('mul-float', 11, 5, 7).op('add-float', 13, 13, 11)
    .op('const', 8, fbits(WALK_Y)).op('mul-float', 14, 3, 8).op('mul-float', 11, 6, 7).op('add-float', 14, 14, 11)
    // One touch transition per frame: pinch > A > walk.
    .op('sget', 5, fld('pinch')).op('if-eqz', 5, 'noPinch')
    .op('invoke-static', own('pinchStep', V, F, F, F), 2, 3, 4).op('goto/16', 'act')
    .label('noPinch')
    .op('sget-boolean', 5, fld('a')).op('if-eqz', 5, 'noA')
    .op('sget-boolean', 6, fld('aWant')).op('sget', 7, fld('cx')).op('sget', 8, fld('cy')).op('if-nez', 6, 'aMove')
    .op('const/4', 6, ACT.UP).op('invoke-static', own('touch', V, I, F, F), 6, 7, 8).op('const/4', 6, 0).op('sput-boolean', 6, fld('a')).op('goto/16', 'act')
    .label('aMove').op('const/4', 6, ACT.MOVE).op('invoke-static', own('touch', V, I, F, F), 6, 7, 8).op('goto/16', 'act')
    .label('noA')
    .op('sget-boolean', 5, fld('aWant')).op('sget-boolean', 6, fld('aHit')).op('or-int', 5, 5, 6)
    .op('sget', 6, fld('zoom'))
    .op('sget-boolean', 7, fld('walk')).op('if-eqz', 7, 'noWalk')
    .op('if-eqz', 12, 'walkEnd').op('if-nez', 5, 'walkEnd').op('if-nez', 6, 'walkEnd')
    .op('const/4', 7, ACT.MOVE).op('invoke-static', own('touch', V, I, F, F), 7, 13, 14).op('sput', 13, fld('wx')).op('sput', 14, fld('wy')).op('goto/16', 'act')
    .label('walkEnd').op('const/4', 7, ACT.UP).op('sget', 13, fld('wx')).op('sget', 14, fld('wy'))
    .op('invoke-static', own('touch', V, I, F, F), 7, 13, 14).op('const/4', 7, 0).op('sput-boolean', 7, fld('walk')).op('goto/16', 'act')
    .label('noWalk')
    .op('if-eqz', 5, 'noAReq')
    .op('const/4', 7, ACT.DOWN).op('sget', 13, fld('cx')).op('sget', 14, fld('cy')).op('invoke-static', own('touch', V, I, F, F), 7, 13, 14)
    .op('const/4', 7, 1).op('sput-boolean', 7, fld('a')).op('const/4', 7, 0).op('sput-boolean', 7, fld('aHit')).op('goto/16', 'act')
    .label('noAReq')
    .op('if-eqz', 6, 'noZoom')
    .op('const/4', 7, 1).op('if-gtz', 6, 'zoomIn').op('const/4', 7, 0).op('add-int/lit8', 6, 6, 1).op('goto', 'zoomSet')
    .label('zoomIn').op('add-int/lit8', 6, 6, -1)
    .label('zoomSet').op('sput-boolean', 7, fld('pinchIn')).op('sput', 6, fld('zoom')).op('const/4', 7, 1).op('sput', 7, fld('pinch'))
    .op('invoke-static', own('pinchStep', V, F, F, F), 2, 3, 4).op('goto/16', 'act')
    .label('noZoom')
    .op('if-eqz', 12, 'idle')
    .op('const/4', 7, ACT.DOWN).op('invoke-static', own('touch', V, I, F, F), 7, 13, 14).op('sput', 13, fld('wx')).op('sput', 14, fld('wy'))
    .op('const/4', 7, 1).op('sput-boolean', 7, fld('walk'))
    .label('act').op('const/4', 9, 1)
    .label('idle')
    // Keep ticking while active; hide the cursor and stop after CURSOR_HIDE_MS without input.
    .op('if-eqz', 9, 'check').op('sput-wide', 0, fld('last')).label('check')
    .op('sget-wide', 5, fld('last')).op('sub-long', 5, 0, 5).op('const-wide/16', 7, CURSOR_HIDE_MS).op('cmp-long', 11, 5, 7).op('if-lez', 11, 'again')
    .op('sget-object', 5, fld('cursor')).op('const/4', 6, 4).op('invoke-virtual', m(VIEW, 'setVisibility', V, I), 5, 6)
    .op('const/4', 6, 0).op('sput-boolean', 6, fld('ticking')).op('return-void')
    .label('again')
    .op('sget-object', 5, fld('root')).op('sget-object', 6, fld('inst')).op('const-wide/16', 7, 16)
    .op('invoke-virtual', m(VIEW, 'postDelayed', Z, RUNNABLE, J), 5, 6, 7, 8).op('return-void');
  add('tick', V, [], S, tick);
}

interface Hook { method: MethodInfo; hooked: boolean }
interface State { set: DexSet; dex: DexFile; cls: DexClass; key: Hook; motion: Hook; hasClass: boolean }

function state(set: DexSet): State | undefined {
  const hit = set.findClass(WINDOW_DIALOG_CLASS);
  const key = hit?.cls.findMethod('dispatchKeyEvent', [KEY], Z);
  const motion = hit?.cls.findMethod('onGenericMotionEvent', [MOTION], Z);
  // The hook needs one spare register below the two arguments.
  const usable = (mi: MethodInfo | undefined): mi is MethodInfo => !!mi?.hasCode && !mi.direct && hit!.cls.codeOf(mi)!.registers > 2;
  if (!hit || !usable(key) || !usable(motion)) return undefined;
  const hook = (mi: MethodInfo): Hook => ({ method: mi, hooked: callsClass(hit.dex, hit.cls, mi, G) });
  return { set, dex: hit.dex, cls: hit.cls, key: hook(key), motion: hook(motion), hasClass: !!set.findClass(G) };
}

function detect(ctx: PatchContext): PatchStatus {
  const set = openDexSet(ctx);
  const s = set && state(set);
  if (!s) return 'incompatible';
  return s.key.hooked && s.motion.hooked && s.hasClass ? 'applied' : 'notApplied';
}

/** Prefix: `if (Gamepad.<name>(this, event)) return true;` (v0 is a local, the arguments are the last two registers). */
function hookPrefix(dex: DexFile, name: string, param: string) {
  const target = dex.method(G, name, Z, [DIALOG, param]);
  return (registers: number): CodeBuilder => new CodeBuilder({ registers, outs: 2 })
    .op('invoke-static', target, registers - 2, registers - 1).op('move-result', 0).op('if-eqz', 0, 'continue').op('return', 0).label('continue');
}

/**
 * OPT-IN. Lets the game be played with a game controller. The game's UIWindow lives in a Dialog (`Window$WindowDialog`)
 * created on Apportable's own UI thread; its `dispatchKeyEvent` and `onGenericMotionEvent` now ask `Gamepad` first, so every
 * controller event (and every synthetic touch, dispatched back into the same dialog) stays on that thread. Mapping:
 * left stick walks (a touch held beside the screen centre at head height; the camera follows the selected blockhead), right stick and
 * d-pad move a cursor, A taps/holds at the cursor, B and Start send Back (pause menu), L1/R1 pinch out/in one step,
 * Y or R3 cycles zoom levels. Non-controller input is untouched.
 */
export const gamepadControls: Patch = {
  id: 'gamepad-controls',
  version: 1,
  nameKey: 'patch.gamepad-controls.name',
  descriptionKey: 'patch.gamepad-controls.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads' },
  optIn: true,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`gamepad-controls cannot be applied (status: ${status})`, 'cannotApply', { status });
    const s = state(openDexSet(ctx)!)!;
    editDex('gamepad-controls', () => {
      if (!s.hasClass) addGamepad(s.dex);
      if (!s.key.hooked) s.cls.prependCode(s.key.method, hookPrefix(s.dex, 'onKey', KEY));
      if (!s.motion.hooked) s.cls.prependCode(s.motion.method, hookPrefix(s.dex, 'onMotion', MOTION));
      s.set.commit();
    });
    ctx.log('gamepad-controls: game dialog key and motion input routed through Gamepad (cursor, touches, pinch zoom)');
  },
};
