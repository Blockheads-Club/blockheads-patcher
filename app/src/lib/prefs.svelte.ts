const KEY_LOG = 'bhp.showLog';
const KEY_CONSENT = 'bhp.consent';
const CONSENT_VERSION = '1';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: the choice lasts for this session only */ }
}

export function hasConsent(): boolean { return read(KEY_CONSENT) === CONSENT_VERSION; }
export function giveConsent(): void { write(KEY_CONSENT, CONSENT_VERSION); }

/** Small persisted UI preferences. */
export class Prefs {
  showLog = $state(read(KEY_LOG) !== '0');
  setShowLog(v: boolean): void { this.showLog = v; write(KEY_LOG, v ? '1' : '0'); }
}
