import { getEntry, peekData, setEntry, type ZipArchive } from '../zip';
import { DexFile, type DexClass } from './dex';

const DEX_NAME = /^classes(\d*)\.dex$/;

/** Names of the dex files in an APK in loading order (classes.dex, classes2.dex, classes3.dex, ...). */
export function dexNames(zip: ZipArchive): string[] {
  return zip.entries
    .map((e) => e.name)
    .filter((n) => DEX_NAME.test(n))
    .sort((a, b) => Number(DEX_NAME.exec(a)![1] || 1) - Number(DEX_NAME.exec(b)![1] || 1));
}

/** All dex files of an APK, parsed on first use; `commit` writes back only the files that were edited. */
export class DexSet {
  private readonly files = new Map<string, DexFile>();
  readonly names: string[];
  constructor(private readonly zip: ZipArchive) {
    this.names = dexNames(zip);
  }

  /** The parsed dex with this entry name. */
  get(name: string): DexFile {
    let f = this.files.get(name);
    if (!f) {
      f = DexFile.parse(peekData(getEntry(this.zip, name)!));
      this.files.set(name, f);
    }
    return f;
  }

  /** Finds the first dex (in loading order) defining the class. */
  findClass(descriptor: string): { name: string; dex: DexFile; cls: DexClass } | undefined {
    for (const name of this.names) {
      const dex = this.get(name);
      const cls = dex.findClass(descriptor);
      if (cls) return { name, dex, cls };
    }
    return undefined;
  }

  /** Every class in every dex whose direct superclass is `superDescriptor`. */
  subclassesOf(superDescriptor: string): { name: string; dex: DexFile; cls: DexClass }[] {
    return this.names.flatMap((name) => {
      const dex = this.get(name);
      return dex.subclassesOf(superDescriptor).map((cls) => ({ name, dex, cls }));
    });
  }

  /** Serializes every edited dex back into the archive (entry position and compression method are kept). */
  commit(): string[] {
    const written: string[] = [];
    for (const [name, dex] of this.files) {
      if (!dex.dirty) continue;
      setEntry(this.zip, { name, data: dex.serialize() });
      dex.dirty = false;
      written.push(name);
    }
    return written;
  }
}
