/** A synthetic mod loader build for tests: a tiny 32-bit ARM ELF and a dex with the loader's listener class. */
import { MOD_LOADER_LISTENER, MOD_LOADER_LISTENER_CLASS, sha256HexSync } from '../../src';
import { setEntry, writeZip, type ZipArchive } from '../../src/zip';
import { buildDex, type ClsSpec } from './fixture';

export const fakeElf = (tag = 0): Uint8Array => {
  const b = new Uint8Array(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1], 0);
  b.set([3, 0, 40, 0], 16);
  b[40] = tag;
  return b;
};

export const LISTENER_SPEC: ClsSpec = { name: MOD_LOADER_LISTENER_CLASS, super: 'Ljava/lang/Object;' };

export function fakeLoaderZip(version = '0.1.0', lib = fakeElf(), dex = buildDex({ classes: [LISTENER_SPEC] })): Uint8Array {
  const json = JSON.stringify({
    version, listener: MOD_LOADER_LISTENER, libName: 'bhmodloader',
    lib: { sha256: sha256HexSync(lib), size: lib.length }, dex: { sha256: sha256HexSync(dex), size: dex.length },
  });
  const zip: ZipArchive = { entries: [] };
  setEntry(zip, { name: 'loader.json', data: new TextEncoder().encode(json), method: 0 });
  setEntry(zip, { name: 'libbhmodloader.so', data: lib, method: 0 });
  setEntry(zip, { name: 'classes.dex', data: dex, method: 0 });
  return writeZip(zip);
}
