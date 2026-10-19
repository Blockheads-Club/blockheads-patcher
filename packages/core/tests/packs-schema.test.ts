import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PACK_SCHEMA, validateSchema, type Schema } from '../src/packs';
import { arrayAppend, arrayHasString, countOf, escapeXml, parsePlist, plistHas, plistSet, unescapeXml } from '../src/packs/plist';

const v = (s: Schema, x: unknown) => validateSchema(s, x).map((i) => `${i.path} ${i.message}`);

describe('JSON schema subset', () => {
  it('checks types (integers count as numbers)', () => {
    expect(v({ type: 'integer' }, 1.5)).toEqual([' must be an integer, not number']);
    expect(v({ type: 'number' }, 2)).toEqual([]);
    expect(v({ type: 'string' }, null)).toEqual([' must be a string, not null']);
    expect(v({ type: 'object' }, [])).toEqual([' must be an object, not array']);
    expect(v({ type: 'array' }, {})).toEqual([' must be an array, not object']);
    expect(v({ type: 'boolean' }, 'x')).toEqual([' must be a boolean, not string']);
  });

  it('checks scalars', () => {
    expect(v({ const: 1 }, 2)).toEqual([' must be 1']);
    expect(v({ enum: ['a', 'b'] }, 'c')).toEqual([' must be one of "a", "b"']);
    expect(v({ type: 'string', minLength: 2, maxLength: 3, pattern: '^a' }, 'b')).toEqual([' must be at least 2 characters long', ' must match ^a']);
    expect(v({ type: 'string', maxLength: 3 }, 'abcd')).toEqual([' must be at most 3 characters long']);
    expect(v({ type: 'string', maxLength: 1 }, '😀')).toEqual([]);
    expect(v({ type: 'integer', minimum: 1, maximum: 2 }, 0)).toEqual([' must be >= 1']);
    expect(v({ type: 'integer', minimum: 1, maximum: 2 }, 3)).toEqual([' must be <= 2']);
  });

  it('checks arrays', () => {
    expect(v({ type: 'array', minItems: 2 }, [1])).toEqual([' must have at least 2 items']);
    expect(v({ type: 'array', maxItems: 1, items: { type: 'string' } }, [1, 2])).toEqual([' must have at most 1 items']);
    expect(v({ type: 'array', uniqueItems: true }, [1, 1])).toEqual([' must not contain duplicates']);
    expect(v({ type: 'array', items: { type: 'string' } }, ['a', 1])).toEqual(['/1 must be a string, not integer']);
  });

  it('checks objects', () => {
    const s: Schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } };
    expect(v(s, { b: 1 })).toEqual([' is missing required property "a"', '/b is not an allowed property']);
    expect(v({ type: 'object', additionalProperties: { type: 'integer' } }, { 'x/y~': 'z' })).toEqual(['/x~1y~0 must be an integer, not string']);
    expect(v({ type: 'object', propertyNames: { type: 'string', pattern: '^[a-z]+$' } }, { A: 1 })).toEqual(['/A name must match ^[a-z]+$']);
    expect(v({ type: 'object', minProperties: 1 }, {})).toEqual([' must have at least 1 properties']);
    expect(v({ type: 'object', maxProperties: 1, required: ['zz'] }, { a: 1, b: 2 })).toEqual([' must have at most 1 properties']);
    expect(v({ type: 'object' }, { any: 1 })).toEqual([]);
  });

  it('resolves oneOf by a discriminator or by counting matches', () => {
    const tagged: Schema = { oneOf: [
      { type: 'object', properties: { op: { const: 'a' }, x: { type: 'integer' } } },
      { type: 'object', properties: { op: { const: 'b' } } },
    ] };
    expect(v(tagged, { op: 'a', x: 's' })).toEqual(['/x must be an integer, not string']);
    expect(v(tagged, { op: 'c' })).toEqual(['/op must be one of "a", "b"']);
    expect(v(tagged, 'not an object')).toEqual([' does not match any allowed form']);
    const plain: Schema = { oneOf: [{ type: 'integer' }, { type: 'number' }, { type: 'string' }] };
    expect(v(plain, 'x')).toEqual([]);
    expect(v(plain, 1)).toEqual([' matches more than one allowed form']);
    expect(v(plain, true)).toEqual([' does not match any allowed form']);
    expect(v({ oneOf: [] }, 1)).toEqual([' does not match any allowed form']);
    expect(v({ oneOf: [{ type: 'object' }, { type: 'object', properties: { op: { const: 'x' } } }] }, {})).toEqual([' matches more than one allowed form']);
  });

  it('follows local $refs and refuses unknown ones', () => {
    const s: Schema = { $defs: { n: { $ref: '#/$defs/m' }, m: { type: 'integer' } }, type: 'array', items: { $ref: '#/$defs/n' } };
    expect(v(s, [1, 'a'])).toEqual(['/1 must be an integer, not string']);
    expect(() => v({ $ref: '#/$defs/none' }, 1)).toThrow(/unresolvable/);
    expect(() => v({ $ref: 'http://x' }, 1)).toThrow(/unresolvable/);
  });

  it('caps the number of issues', () => {
    expect(validateSchema({ type: 'array', items: { type: 'string' } }, Array(80).fill(1))).toHaveLength(50);
  });

  it('is published as docs/pack.schema.json', () => {
    const file = JSON.parse(readFileSync(new URL('../../../docs/pack.schema.json', import.meta.url), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(PACK_SCHEMA)));
  });
});

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- comment -->
<dict>
\t<key>CFBundleName</key>
\t<string>Block &amp; heads</string>
\t<key>UIAppFonts</key>
\t<array>
\t\t<string>A.ttf</string>
\t</array>
\t<key>Empty</key>
\t<array/>
\t<key>Open</key>
\t<array></array>
\t<key>Flag</key>
\t<true/>
\t<key>Nested</key>
\t<dict><key>Inner</key><string>x</string></dict>
\t<key>Count</key>
\t<integer>3</integer>
\t<key>Data</key>
\t<string><![CDATA[raw]]></string>
</dict>
</plist>
`;

describe('XML property lists', () => {
  it('lists top-level keys only', () => {
    const d = parsePlist(PLIST)!;
    expect([...d.entries.keys()]).toEqual(['CFBundleName', 'UIAppFonts', 'Empty', 'Open', 'Flag', 'Nested', 'Count', 'Data']);
    expect(d.entries.get('Flag')).toMatchObject({ tag: 'true' });
    expect(PLIST.slice(d.rootClose, d.rootClose + 7)).toBe('</dict>');
  });

  it('rejects other documents', () => {
    for (const bad of ['<dict></dict>', '<plist><array/></plist>', '<plist><dict><string>x</string></dict></plist>', '<plist><dict></array></plist>',
      '<plist><dict>', '<plist></plist>', 'bplist00'])
      expect(parsePlist(bad), bad).toBeUndefined();
  });

  it('compares and sets scalar values', () => {
    const d = parsePlist(PLIST)!, e = (k: string) => d.entries.get(k)!;
    expect(plistHas(PLIST, e('CFBundleName'), 'Block & heads')).toBe(true);
    expect(plistHas(PLIST, e('CFBundleName'), 'x')).toBe(false);
    expect(plistHas(PLIST, e('Flag'), true)).toBe(true);
    expect(plistHas(PLIST, e('Flag'), false)).toBe(false);
    expect(plistHas(PLIST, e('Count'), 3)).toBe(true);
    expect(plistHas(PLIST, e('Flag'), 3)).toBe(false);
    expect(plistHas(PLIST, e('Count'), 4)).toBe(false);
    expect(plistHas(PLIST, e('Count'), '3')).toBe(false);
    const set = plistSet(PLIST, d, 'Count', 7);
    expect(set).toContain('<integer>7</integer>');
    expect(set.length).toBe(PLIST.length);
    expect(plistSet(PLIST, d, 'Count', true)).toContain('<key>Count</key>\n\t<true/>');
    const added = plistSet(PLIST, d, 'New<', false);
    expect(added).toContain('\t<key>New&lt;</key>\n\t<false/>\n</dict>');
    expect(parsePlist(added)!.entries.get('New<')!.tag).toBe('false');
    expect(plistSet(PLIST, d, 'Flag', 'a<b')).toContain('<key>Flag</key>\n\t<string>a&lt;b</string>');
  });

  it('appends strings to arrays', () => {
    const d = parsePlist(PLIST)!, e = (k: string) => d.entries.get(k)!;
    expect(arrayHasString(PLIST, e('UIAppFonts'), 'A.ttf')).toBe(true);
    expect(arrayHasString(PLIST, e('UIAppFonts'), 'B.ttf')).toBe(false);
    expect(arrayAppend(PLIST, e('UIAppFonts'), 'B.ttf')).toContain('<string>A.ttf</string>\n\t\t<string>B.ttf</string>\n\t</array>');
    expect(arrayAppend(PLIST, e('Empty'), 'C')).toContain('<key>Empty</key>\n\t<array>\n\t\t<string>C</string>\n\t</array>\n');
    expect(arrayAppend(PLIST, e('Open'), 'D')).toContain('<array>\n\t\t<string>D</string></array>');
  });

  it('escapes and counts', () => {
    expect(escapeXml('<a & b>')).toBe('&lt;a &amp; b&gt;');
    expect(unescapeXml('&lt;&gt;&quot;&apos;&amp;lt;')).toBe('<>"\'&lt;');
    expect(countOf('aaaa', 'aa')).toBe(2);
    expect(countOf('abc', 'x')).toBe(0);
  });
});
