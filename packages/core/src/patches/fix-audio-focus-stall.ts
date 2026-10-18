import { CodeBuilder, type DexFile } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { makeMethodRewritePatch, type MethodRewriteSpec } from './method-rewrite';
import { AUDIO_MANAGER_CLASS } from './music-with-other-apps';

const STR = 'Ljava/lang/String;', SB = 'Ljava/lang/StringBuilder;', LOG = 'Landroid/util/Log;', LOOPER = 'Landroid/os/Looper;';
const TAG = 'AndroidAudioManager';

/**
 * `waitOnConnection()` as shipped: polls up to 400 x 5 ms for the audio service, then marks it failed. With
 * `guard`, it first returns at once when called on the main thread.
 */
function body(dex: DexFile, guard: boolean): CodeBuilder {
  const f = (name: string, type: string): number => dex.field(AUDIO_MANAGER_CLASS, name, type);
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const b = new CodeBuilder({ registers: 5, outs: 2 });
  if (guard) {
    b.op('invoke-static', m(LOOPER, 'myLooper', LOOPER)).op('move-result-object', 0)
      .op('invoke-static', m(LOOPER, 'getMainLooper', LOOPER)).op('move-result-object', 1)
      .op('if-ne', 0, 1, 'start').op('return-void').label('start');
  }
  return b
    .op('const/16', 0, 400)
    .label('loop').op('add-int/lit8', 0, 0, -1)
    .op('if-lez', 0, 'fail')
    .op('iget-boolean', 1, 4, f('audioManagerServiceFailed', 'Z')).op('if-nez', 1, 'fail')
    .op('iget-object', 1, 4, f('audioManagerService', 'Lcom/apportable/media/AudioManagerService;')).op('if-eqz', 1, 'sleep')
    .op('const-string', 1, dex.string(TAG))
    .op('new-instance', 2, dex.type(SB))
    .op('invoke-direct', m(SB, '<init>', 'V'), 2)
    .op('const-string', 3, dex.string('audioManagerService success with remaining attemps:'))
    .op('invoke-virtual', m(SB, 'append', SB, STR), 2, 3).op('move-result-object', 2)
    .op('invoke-virtual', m(SB, 'append', SB, 'I'), 2, 0).op('move-result-object', 0)
    .op('invoke-virtual', m(SB, 'toString', STR), 0).op('move-result-object', 0)
    .op('invoke-static', m(LOG, 'e', 'I', STR, STR), 1, 0)
    .label('ret').op('return-void')
    .label('sleep').op('const-wide/16', 2, 5)
    .label('s0').op('invoke-static', m('Ljava/lang/Thread;', 'sleep', 'V', 'J'), 2, 3)
    .label('s1').op('goto', 'loop')
    .label('catch').op('move-exception', 1).op('goto', 'loop')
    .label('fail').op('const/4', 0, 1)
    .op('iput-boolean', 0, 4, f('audioManagerServiceFailed', 'Z'))
    .op('const-string', 0, dex.string(TAG))
    .op('const-string', 1, dex.string('Failed waiting for AudioManagerService!'))
    .op('invoke-static', m(LOG, 'e', 'I', STR, STR), 0, 1)
    .op('goto', 'ret')
    .tryCatch({ start: 's0', end: 's1', handlers: [{ type: dex.type('Ljava/lang/InterruptedException;'), label: 'catch' }] });
}

/**
 * The first audio-focus request runs on the UI thread and `waitOnConnection()` sleeps up to 2 s there, waiting for a
 * service connection that only the blocked UI thread could deliver. On the main thread it now returns at once (the
 * callers already cope with the service being absent); other threads keep the original wait.
 */
export const fixAudioFocusStallSpec: MethodRewriteSpec = {
  id: 'fix-audio-focus-stall',
  credits: JARLPENGUIN_CREDITS,
  cls: AUDIO_MANAGER_CLASS,
  method: { name: 'waitOnConnection', params: [], returnType: 'V' },
  original: (dex) => body(dex, false),
  patched: (dex) => body(dex, true),
  logMessage: 'AndroidAudioManager.waitOnConnection() no longer sleeps on the main thread',
};
export const fixAudioFocusStall = makeMethodRewritePatch(fixAudioFocusStallSpec);
