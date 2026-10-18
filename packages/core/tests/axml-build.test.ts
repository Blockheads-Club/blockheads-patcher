import { describe, it, expect } from 'vitest';
import { buildAxml, parseAxml, serializeAxml, ANDROID_NS, ValueType, getAttr, findElements } from '../src';

describe('buildAxml', () => {
  const doc = () => buildAxml({
    name: 'adaptive-icon',
    children: [
      { name: 'background', attrs: [{ name: 'drawable', resourceId: 0x01010199, value: { type: ValueType.Reference, data: 0x7f040023 } }] },
      { name: 'foreground', attrs: [
        { name: 'custom', value: { string: 'hello' } },
        { name: 'drawable', resourceId: 0x01010199, value: { type: ValueType.Reference, data: 0x7f0a0000 } },
        { name: 'alpha', resourceId: 0x0101031f, value: { type: ValueType.Float, data: 0x3f800000 } },
      ] },
    ],
  });
  it('produces a document the parser reads back and re-serializes byte-identically', () => {
    const b = doc();
    const d = parseAxml(b);
    expect(d.root.name).toBe('adaptive-icon');
    expect(d.root.children.map((c) => c.name)).toEqual(['background', 'foreground']);
    const bg = getAttr(d.root.children[0]!, 'drawable', ANDROID_NS, 0x01010199)!;
    expect([bg.valueType, bg.data]).toEqual([ValueType.Reference, 0x7f040023]);
    const fg = d.root.children[1]!;
    // attributes with resource ids come first, in id order
    expect(fg.attributes.map((a) => a.name)).toEqual(['drawable', 'alpha', 'custom']);
    expect(fg.attributes[2]!.stringValue).toBe('hello');
    expect(Buffer.from(serializeAxml(d)).equals(Buffer.from(b))).toBe(true);
    expect(findElements(d, (e) => e.name === 'foreground')).toHaveLength(1);
  });
  it('supports custom namespaces, explicit attribute namespaces and no namespace', () => {
    const b = buildAxml(
      { name: 'x', attrs: [{ name: 'p', nsUri: 'urn:foo', value: { string: 'v' } }, { name: 'q', nsUri: null, value: { type: ValueType.IntDec, data: 5 } }] },
      { namespaces: [{ prefix: 'foo', uri: 'urn:foo' }] },
    );
    const d = parseAxml(b);
    expect(getAttr(d.root, 'p', 'urn:foo')!.stringValue).toBe('v');
    expect(getAttr(d.root, 'q', null)!.data).toBe(5);
    const none = parseAxml(buildAxml({ name: 'y' }, { namespaces: [] }));
    expect(none.root.attributes).toEqual([]);
  });
  it('rejects one attribute name bound to two resource ids', () => {
    expect(() => buildAxml({ name: 'x', attrs: [
      { name: 'a', resourceId: 1, value: { type: 0x10, data: 1 } }, { name: 'a', resourceId: 2, value: { type: 0x10, data: 1 } },
    ] })).toThrow(/unique/);
  });
});
