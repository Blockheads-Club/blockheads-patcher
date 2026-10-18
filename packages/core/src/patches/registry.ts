import { fixWelcomePopupDeadlock } from './fix-welcome-popup-deadlock';
import { fixIapStoreFontCrash } from './fix-iap-store-font-crash';
import { enableAudioCapture } from './enable-audio-capture';
import { keepDataOnUninstall } from './keep-data-on-uninstall';
import { disableMultiWindow } from './disable-multi-window';
import { raiseTargetSdk } from './raise-target-sdk';
import { fixWebviewCrash } from './fix-webview-crash';
import { fixEmailShareLink } from './fix-email-share-link';
import { fixJoinLinks } from './fix-join-links';
import { musicWithOtherApps } from './music-with-other-apps';
import { fixAudioFocusStall } from './fix-audio-focus-stall';
import { fixTextActivityFreeze } from './fix-text-activity-freeze';
import { fixSurfaceDestroyFreeze } from './fix-surface-destroy-freeze';
import { fixBackgroundWakeup } from './fix-background-wakeup';
import { adaptiveIcon } from './adaptive-icon';
import { PatchError, type Patch, type PatchRegistry } from './types';

export function createRegistry(patches: Patch[] = []): PatchRegistry {
  const map = new Map<string, Patch>();
  const reg: PatchRegistry = {
    register(p) {
      if (map.has(p.id)) throw new PatchError(`duplicate patch id: ${p.id}`, 'duplicatePatch', { id: p.id });
      map.set(p.id, p);
    },
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
  patches.forEach((p) => reg.register(p));
  return reg;
}

export const defaultRegistry: PatchRegistry = createRegistry([
  fixWelcomePopupDeadlock, fixIapStoreFontCrash, enableAudioCapture, keepDataOnUninstall, disableMultiWindow, raiseTargetSdk,
  fixWebviewCrash, fixEmailShareLink,
  fixJoinLinks,
  musicWithOtherApps, fixAudioFocusStall, fixTextActivityFreeze, fixSurfaceDestroyFreeze, fixBackgroundWakeup,
  adaptiveIcon,
]);
