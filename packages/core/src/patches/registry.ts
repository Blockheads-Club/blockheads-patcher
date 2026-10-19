import { fixWelcomePopupDeadlock } from './fix-welcome-popup-deadlock';
import { fixIapStoreFontCrash } from './fix-iap-store-font-crash';
import { fixSystemFontCrash } from './fix-system-font-crash';
import { enableAudioCapture } from './enable-audio-capture';
import { keepDataOnUninstall } from './keep-data-on-uninstall';
import { allowResizing } from './allow-resizing';
import { raiseTargetSdk } from './raise-target-sdk';
import { fixPrivacyDialog } from './fix-privacy-dialog';
import { fixWelcomeMessageText } from './fix-welcome-message-text';
import { fixInviteEmailTypo } from './fix-invite-email-typo';
import { signsLowercase } from './signs-lowercase';
import { fixWebviewCrash } from './fix-webview-crash';
import { fixConfigChangeCrash } from './fix-config-change-crash';
import { fixEmailShareLink } from './fix-email-share-link';
import { fixJoinLinks } from './fix-join-links';
import { musicWithOtherApps } from './music-with-other-apps';
import { fixAudioFocusStall } from './fix-audio-focus-stall';
import { fixTextActivityFreeze } from './fix-text-activity-freeze';
import { fixSurfaceDestroyFreeze } from './fix-surface-destroy-freeze';
import { fixBackgroundWakeup } from './fix-background-wakeup';
import { adaptiveIcon } from './adaptive-icon';
import { signEditorCentred } from './sign-editor-centred';
import { lanMulticast } from './lan-multicast';
import { tabletLayout } from './tablet-layout';
import { musicResume } from './fix-music-resume';
import { menuMusicLoop } from './menu-music-loop';
import { worldSelectionKeep } from './world-selection-keep';
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
  fixWelcomePopupDeadlock, fixIapStoreFontCrash, fixSystemFontCrash, enableAudioCapture, keepDataOnUninstall, allowResizing, raiseTargetSdk,
  fixPrivacyDialog, fixWelcomeMessageText, fixInviteEmailTypo, signsLowercase,
  fixWebviewCrash, fixConfigChangeCrash, fixEmailShareLink,
  fixJoinLinks,
  musicWithOtherApps, fixAudioFocusStall, fixTextActivityFreeze, fixSurfaceDestroyFreeze, fixBackgroundWakeup,
  adaptiveIcon,
  signEditorCentred, lanMulticast, tabletLayout,
  musicResume, menuMusicLoop, worldSelectionKeep,
]);
