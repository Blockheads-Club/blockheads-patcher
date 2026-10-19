import type { ElfSection } from '../elf/symbols';
import type { ElfImage } from './image';

const METHOD_RE = /^([+-])\[([A-Za-z_$][A-Za-z0-9_$]*) ([A-Za-z_$:][A-Za-z0-9_$:]*)\]$/;
const MAX_METHODS = 1 << 16;

/**
 * Implementation address of an Objective-C method (`-[Class selector:]`, `+[Class selector]`) defined in a class of
 * `__objc_classlist`, using the 32-bit Objective-C 2 ABI as Apportable builds lay it out (`class_t.data` at +16,
 * `class_ro_t.name` at +16 and `.baseMethods` at +20, `method_t {name, types, imp}`). Thumb implementations come without
 * their low bit. Category methods are not searched. Undefined when not found or the metadata is unreadable.
 */
export function findObjcMethod(img: ElfImage, sections: ElfSection[], spec: string): number | undefined {
  const m = METHOD_RE.exec(spec);
  if (!m) return undefined;
  const [, kind, className, selector] = m as unknown as [string, string, string, string];
  const list = sections.find((s) => s.name.includes('__objc_classlist'));
  if (!list) return undefined;
  const roOf = (cls: number): number | undefined => {
    const data = img.readU32(cls + 16);
    return data === undefined ? undefined : data & ~3;
  };
  for (let p = list.addr; p + 4 <= list.addr + list.size; p += 4) {
    const cls = img.readU32(p);
    const ro = cls === undefined ? undefined : roOf(cls);
    const namePtr = ro === undefined ? undefined : img.readU32(ro + 16);
    if (namePtr === undefined || img.readCString(namePtr) !== className) continue;
    // cls + 16 was readable, so its isa word is too
    const ownerRo = roOf(kind === '+' ? img.readU32(cls!)! : cls!);
    const methods = ownerRo === undefined ? undefined : img.readU32(ownerRo + 20);
    if (!methods) return undefined;
    const entsize = img.readU32(methods)! & ~3, count = img.readU32(methods + 4);
    if (count === undefined || entsize < 12) return undefined;
    for (let i = 0; i < Math.min(count, MAX_METHODS); i++) {
      const e = methods + 8 + i * entsize;
      const sel = img.readU32(e);
      if (sel === undefined) return undefined;
      if (img.readCString(sel) !== selector) continue;
      const imp = img.readU32(e + 8);
      return imp === undefined ? undefined : (imp & ~1) >>> 0;
    }
    return undefined;
  }
  return undefined;
}
