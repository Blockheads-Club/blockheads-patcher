import { JARLPENGUIN_CREDITS } from './credits';
import { makeTranslucentActivityPatch } from './translucent-activity';

/**
 * `TextViewHaxActivity` (the keyboard workaround page) has no theme and is opaque, so showing it makes Android
 * stop the game activity, with the same freeze risk as the welcome popup. Same translucent theme, other activity.
 */
export const fixTextActivityFreeze = makeTranslucentActivityPatch({
  id: 'fix-text-activity-freeze',
  activity: 'com.apportable.ui.TextViewHaxActivity',
  credits: JARLPENGUIN_CREDITS,
  logMessage: 'TextViewHaxActivity theme set to Theme.Translucent.NoTitleBar.Fullscreen',
});
