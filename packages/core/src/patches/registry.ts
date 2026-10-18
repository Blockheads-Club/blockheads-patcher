import { fixWelcomePopupDeadlock } from './fix-welcome-popup-deadlock';
import { fixIapStoreFontCrash } from './fix-iap-store-font-crash';
import { enableAudioCapture } from './enable-audio-capture';
import { keepDataOnUninstall } from './keep-data-on-uninstall';
import { disableMultiWindow } from './disable-multi-window';
import { raiseTargetSdk } from './raise-target-sdk';
import { fixPrivacyDialog } from './fix-privacy-dialog';
import { fixWelcomeMessageText } from './fix-welcome-message-text';
import { fixInviteEmailTypo } from './fix-invite-email-typo';
import { signsLowercase } from './signs-lowercase';
import { fixWebviewCrash } from './fix-webview-crash';
import { fixEmailShareLink } from './fix-email-share-link';
import { fixJoinLinks } from './fix-join-links';
import { adaptiveIcon } from './adaptive-icon';
import { signEditorCentred } from './sign-editor-centred';
import { lanMulticast } from './lan-multicast';
import { tabletLayout } from './tablet-layout';
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
  fixPrivacyDialog, fixWelcomeMessageText, fixInviteEmailTypo, signsLowercase,
  fixWebviewCrash, fixEmailShareLink,
  fixJoinLinks,
  adaptiveIcon,
  signEditorCentred, lanMulticast, tabletLayout,
]);
