/** Text-level edits of XML property lists that keep every byte outside the edited value. */
export type PlistScalar = string | boolean | number;

export interface PlistEntry {
  key: string;
  tag: string;
  /** Range of the whole value element. */
  start: number;
  end: number;
  /** Range of the element's content (equal to `end` for a self-closing element). */
  innerStart: number;
  innerEnd: number;
}
export interface PlistDoc {
  entries: Map<string, PlistEntry>;
  /** Offset of the root dict's closing tag. */
  rootClose: number;
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z][\w.-]*)(?:\s[^>]*?)?(\/?)>/g;

export const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Top-level keys of `<plist><dict>…</dict></plist>`, or undefined when the text is not such a document. */
export function parsePlist(text: string): PlistDoc | undefined {
  const stack: string[] = [];
  const entries = new Map<string, PlistEntry>();
  let keyStart = -1, pendingKey: string | undefined, value: Partial<PlistEntry> | undefined;
  let rootClose = -1;
  for (const m of text.matchAll(TOKEN)) {
    const [tok, close, name, selfClose] = m;
    if (name === undefined) continue;
    const at = m.index, after = at + tok.length;
    const depth = stack.length;
    if (!close) {
      if (depth === 0 && name !== 'plist') return undefined;
      if (depth === 1 && name !== 'dict') return undefined;
      if (depth === 2) {
        if (name === 'key') keyStart = after;
        else if (pendingKey === undefined) return undefined;
        else value = { key: pendingKey, tag: name, start: at, innerStart: after };
      }
      if (selfClose) {
        if (depth === 2 && value) finish(after, after);
        continue;
      }
      stack.push(name);
      continue;
    }
    if (stack.pop() !== name) return undefined;
    if (depth === 3 && name === 'key') pendingKey = unescapeXml(text.slice(keyStart, at));
    else if (depth === 3 && value) finish(after, at);
    else if (depth === 2 && name === 'dict') rootClose = at;
  }
  function finish(end: number, innerEnd: number): void {
    entries.set(value!.key!, { ...(value as PlistEntry), end, innerEnd });
    value = undefined;
    pendingKey = undefined;
  }
  return rootClose < 0 || stack.length ? undefined : { entries, rootClose };
}

export function plistValueXml(v: PlistScalar): string {
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'number') return `<integer>${v}</integer>`;
  return `<string>${escapeXml(v)}</string>`;
}

/** True when the entry holds exactly `v` (strings compared after unescaping). */
export function plistHas(text: string, e: PlistEntry, v: PlistScalar): boolean {
  const inner = text.slice(e.innerStart, e.innerEnd);
  if (typeof v === 'boolean') return e.tag === String(v);
  if (typeof v === 'number') return e.tag === 'integer' && inner.trim() === String(v);
  return e.tag === 'string' && unescapeXml(inner) === v;
}

/** Sets (or adds at the end of the root dict) a top-level key. */
export function plistSet(text: string, doc: PlistDoc, key: string, v: PlistScalar): string {
  const e = doc.entries.get(key);
  if (e) return text.slice(0, e.start) + plistValueXml(v) + text.slice(e.end);
  const add = `\t<key>${escapeXml(key)}</key>\n\t${plistValueXml(v)}\n`;
  return text.slice(0, doc.rootClose) + add + text.slice(doc.rootClose);
}

export const arrayHasString = (text: string, e: PlistEntry, v: string): boolean =>
  text.slice(e.innerStart, e.innerEnd).includes(`<string>${escapeXml(v)}</string>`);

/** Appends a string to an array entry. */
export function arrayAppend(text: string, e: PlistEntry, v: string): string {
  const item = `<string>${escapeXml(v)}</string>`;
  if (e.innerStart === e.end) return `${text.slice(0, e.start)}<array>\n\t\t${item}\n\t</array>${text.slice(e.end)}`;
  const inner = text.slice(e.innerStart, e.innerEnd);
  const trail = /\s*$/.exec(inner)![0];
  const at = e.innerEnd - trail.length;
  return `${text.slice(0, at)}\n\t\t${item}${text.slice(at)}`;
}

/** Number of non-overlapping occurrences of `needle`. */
export function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}
