/**
 * Chromium-based runtimes (Chrome, Android WebView) ship ICU without data for some locales, Kazakh among them: Intl
 * then formats with root patterns ("2026 M10 21", "61.3"). Such a locale borrows the conventions of a related one.
 */
const FALLBACK: Record<string, string> = { kk: 'ru-KZ' };
export function hasLocaleData(locale: string): boolean {
  return !/^M\d/.test(new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, 0, 15)));
}
/** Locale to format numbers with: `locale` itself, or its fallback when the runtime has no data for it. */
export function numberLocale(locale?: string): string | undefined {
  return locale && locale in FALLBACK && !hasLocaleData(locale) ? FALLBACK[locale] : locale;
}

/** Locale-aware size, e.g. "61.3 MB" / "61,3 МБ". Uses decimal units like the OS file managers. */
export function formatBytes(n: number, locale?: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];
  let v = n, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return new Intl.NumberFormat(numberLocale(locale), { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
}

/** Medium date ("Oct 21, 2026"); numeric in the fallback locale's order ("21.10.2026") when the runtime lacks `locale`. */
export function formatDate(ms: number, locale?: string): string {
  const n = numberLocale(locale);
  const opts: Intl.DateTimeFormatOptions = n === locale ? { dateStyle: 'medium' } : { day: '2-digit', month: '2-digit', year: 'numeric' };
  return new Intl.DateTimeFormat(n, opts).format(new Date(ms));
}

export function formatClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "4F:9A:…:C2" style abbreviation of a colon separated fingerprint. */
export function shortFingerprint(fp: string, head = 2, tail = 1): string {
  const parts = fp.split(':');
  return parts.length <= head + tail ? fp : `${parts.slice(0, head).join(':')}…${parts.slice(-tail).join(':')}`;
}
