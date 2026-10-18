import { describe, it, expect } from 'vitest';
import { ACC, CodeBuilder, DexFile, DexSet, dexNames, validateDex } from '../../src/dex';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { buildDex } from './fixture';
import { richDex, BASE, DERIVED } from './samples';

const zipWith = (files: Record<string, Uint8Array>): ZipArchive => {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data, method: 0 });
  return zip;
};
const second = (): Uint8Array => buildDex({ classes: [{ name: 'Lcom/second/Only;', super: BASE }] });

describe('multidex', () => {
  it('orders classes.dex, classes2.dex ... numerically', () => {
    const zip = zipWith({ 'classes10.dex': second(), 'classes2.dex': second(), 'classes.dex': richDex(), 'other.dex': second(), 'classes3.dex': second() });
    expect(dexNames(zip)).toEqual(['classes.dex', 'classes2.dex', 'classes3.dex', 'classes10.dex']);
    expect(new DexSet(zip).names).toHaveLength(4);
  });
  it('finds classes across files and subclasses of a superclass', () => {
    const set = new DexSet(zipWith({ 'classes.dex': richDex(), 'classes2.dex': second() }));
    expect(set.findClass(DERIVED)!.name).toBe('classes.dex');
    expect(set.findClass('Lcom/second/Only;')!.name).toBe('classes2.dex');
    expect(set.findClass('Lnope;')).toBeUndefined();
    expect(set.subclassesOf(BASE).map((x) => [x.name, x.cls.descriptor])).toEqual([['classes.dex', DERIVED], ['classes2.dex', 'Lcom/second/Only;']]);
    expect(set.get('classes.dex')).toBe(set.get('classes.dex'));
  });
  it('commits only edited dex files, keeping entry order and method', () => {
    const zip = zipWith({ 'classes.dex': richDex(), 'classes2.dex': second() });
    const untouched = getEntry(zip, 'classes2.dex')!.data;
    const set = new DexSet(zip);
    const hit = set.findClass(BASE)!;
    hit.cls.addMethod({ name: 'extra', returnType: 'V', params: [], access: ACC.PUBLIC, code: new CodeBuilder({ registers: 1 }).op('return-void') });
    expect(set.commit()).toEqual(['classes.dex']);
    expect(set.commit()).toEqual([]);
    expect(validateDex(getEntry(zip, 'classes.dex')!.data)).toEqual([]);
    expect(DexFile.parse(getEntry(zip, 'classes.dex')!.data).findClass(BASE)!.findMethod('extra')).toBeDefined();
    expect(getEntry(zip, 'classes2.dex')!.data).toBe(untouched);
    expect(zip.entries.map((e) => [e.name, e.method])).toEqual([['classes.dex', 0], ['classes2.dex', 0]]);
  });
});
