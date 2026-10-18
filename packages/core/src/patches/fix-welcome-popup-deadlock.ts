import { makeTranslucentActivityPatch } from './translucent-activity';

export { ANDROID_THEME_ATTR_ID, THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN } from './translucent-activity';

/**
 * The welcome popup activity is opaque, so Android stops the game activity, which deadlocks the game's
 * render thread against the main thread. A translucent theme keeps the game activity only paused.
 */
export const fixWelcomePopupDeadlock = makeTranslucentActivityPatch({
  id: 'fix-welcome-popup-deadlock',
  activity: 'com.noodlecake.noodlewebview.BlockheadsWebView',
  logMessage: 'BlockheadsWebView theme set to Theme.Translucent.NoTitleBar.Fullscreen',
});
