/** Locale-aware size, e.g. "61.3 MB". Uses decimal units like the OS file managers. */
export function formatBytes(n: number, locale?: string): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
  return `${num} ${units[i]}`;
}

export function formatDate(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms));
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
