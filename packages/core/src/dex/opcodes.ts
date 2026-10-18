import { DexError } from './bytes';

/** Dalvik instruction formats (see the "Dalvik Executable instruction formats" documentation). */
export type Format =
  | '10x' | '12x' | '11n' | '11x' | '10t' | '20t' | '22x' | '21t' | '21s' | '21h' | '21c' | '23x' | '22b' | '22t' | '22s' | '22c'
  | '32x' | '30t' | '31i' | '31t' | '31c' | '35c' | '3rc' | '45cc' | '4rcc' | '51l';
/** Which constant pool an instruction's index operand points into. */
export type RefKind = 'string' | 'type' | 'field' | 'method';

export interface OpInfo { op: number; name: string; format: Format }

/** Number of 16-bit code units per format. */
export const FORMAT_UNITS: Record<Format, number> = {
  '10x': 1, '12x': 1, '11n': 1, '11x': 1, '10t': 1, '20t': 2, '22x': 2, '21t': 2, '21s': 2, '21h': 2, '21c': 2, '23x': 2,
  '22b': 2, '22t': 2, '22s': 2, '22c': 2, '32x': 3, '30t': 3, '31i': 3, '31t': 3, '31c': 3, '35c': 3, '3rc': 3, '45cc': 4, '4rcc': 4, '51l': 5,
};

const table: (OpInfo | undefined)[] = new Array(256).fill(undefined);
const byName = new Map<string, OpInfo>();
function def(op: number, name: string, format: Format): void {
  const info: OpInfo = { op, name, format };
  table[op] = info;
  byName.set(name, info);
}
function family(start: number, format: Format, names: string[]): void {
  names.forEach((n, i) => def(start + i, n, format));
}

[
  ['nop', '10x'], ['move', '12x'], ['move/from16', '22x'], ['move/16', '32x'], ['move-wide', '12x'], ['move-wide/from16', '22x'],
  ['move-wide/16', '32x'], ['move-object', '12x'], ['move-object/from16', '22x'], ['move-object/16', '32x'], ['move-result', '11x'],
  ['move-result-wide', '11x'], ['move-result-object', '11x'], ['move-exception', '11x'], ['return-void', '10x'], ['return', '11x'],
  ['return-wide', '11x'], ['return-object', '11x'], ['const/4', '11n'], ['const/16', '21s'], ['const', '31i'], ['const/high16', '21h'],
  ['const-wide/16', '21s'], ['const-wide/32', '31i'], ['const-wide', '51l'], ['const-wide/high16', '21h'], ['const-string', '21c'],
  ['const-string/jumbo', '31c'], ['const-class', '21c'], ['monitor-enter', '11x'], ['monitor-exit', '11x'], ['check-cast', '21c'],
  ['instance-of', '22c'], ['array-length', '12x'], ['new-instance', '21c'], ['new-array', '22c'], ['filled-new-array', '35c'],
  ['filled-new-array/range', '3rc'], ['fill-array-data', '31t'], ['throw', '11x'], ['goto', '10t'], ['goto/16', '20t'], ['goto/32', '30t'],
  ['packed-switch', '31t'], ['sparse-switch', '31t'], ['cmpl-float', '23x'], ['cmpg-float', '23x'], ['cmpl-double', '23x'],
  ['cmpg-double', '23x'], ['cmp-long', '23x'],
].forEach(([n, f], i) => def(i, n!, f as Format));
family(0x32, '22t', ['if-eq', 'if-ne', 'if-lt', 'if-ge', 'if-gt', 'if-le']);
family(0x38, '21t', ['if-eqz', 'if-nez', 'if-ltz', 'if-gez', 'if-gtz', 'if-lez']);
const kinds = ['', '-wide', '-object', '-boolean', '-byte', '-char', '-short'];
family(0x44, '23x', kinds.map((k) => 'aget' + k));
family(0x4b, '23x', kinds.map((k) => 'aput' + k));
family(0x52, '22c', kinds.map((k) => 'iget' + k));
family(0x59, '22c', kinds.map((k) => 'iput' + k));
family(0x60, '21c', kinds.map((k) => 'sget' + k));
family(0x67, '21c', kinds.map((k) => 'sput' + k));
const invokes = ['virtual', 'super', 'direct', 'static', 'interface'];
family(0x6e, '35c', invokes.map((k) => 'invoke-' + k));
family(0x74, '3rc', invokes.map((k) => 'invoke-' + k + '/range'));
family(0x7b, '12x', ['neg-int', 'not-int', 'neg-long', 'not-long', 'neg-float', 'neg-double', 'int-to-long', 'int-to-float', 'int-to-double',
  'long-to-int', 'long-to-float', 'long-to-double', 'float-to-int', 'float-to-long', 'float-to-double', 'double-to-int', 'double-to-long',
  'double-to-float', 'int-to-byte', 'int-to-char', 'int-to-short']);
const arith = ['add', 'sub', 'mul', 'div', 'rem'];
const bits = ['and', 'or', 'xor', 'shl', 'shr', 'ushr'];
const intOps = [...arith, ...bits];
const longOps = [...arith, ...bits];
family(0x90, '23x', intOps.map((o) => o + '-int'));
family(0x9b, '23x', longOps.map((o) => o + '-long'));
family(0xa6, '23x', arith.map((o) => o + '-float'));
family(0xab, '23x', arith.map((o) => o + '-double'));
family(0xb0, '12x', intOps.map((o) => o + '-int/2addr'));
family(0xbb, '12x', longOps.map((o) => o + '-long/2addr'));
family(0xc6, '12x', arith.map((o) => o + '-float/2addr'));
family(0xcb, '12x', arith.map((o) => o + '-double/2addr'));
family(0xd0, '22s', ['add-int/lit16', 'rsub-int', 'mul-int/lit16', 'div-int/lit16', 'rem-int/lit16', 'and-int/lit16', 'or-int/lit16', 'xor-int/lit16']);
family(0xd8, '22b', ['add-int/lit8', 'rsub-int/lit8', 'mul-int/lit8', 'div-int/lit8', 'rem-int/lit8', 'and-int/lit8', 'or-int/lit8', 'xor-int/lit8',
  'shl-int/lit8', 'shr-int/lit8', 'ushr-int/lit8']);
def(0xfa, 'invoke-polymorphic', '45cc');
def(0xfb, 'invoke-polymorphic/range', '4rcc');
def(0xfc, 'invoke-custom', '35c');
def(0xfd, 'invoke-custom/range', '3rc');
def(0xfe, 'const-method-handle', '21c');
def(0xff, 'const-method-type', '21c');

export function opInfo(op: number): OpInfo | undefined { return table[op]; }
export function opByName(name: string): OpInfo {
  const i = byName.get(name);
  if (!i) throw new DexError(`unknown opcode ${name}`);
  return i;
}

/** Index operand kind of an opcode (undefined when it has none). invoke-polymorphic's second (proto) index is handled separately. */
export function refKind(op: number): RefKind | undefined {
  if (op === 0x1a || op === 0x1b) return 'string';
  if (op === 0x1c || op === 0x1f || op === 0x20 || op === 0x22 || op === 0x23 || op === 0x24 || op === 0x25) return 'type';
  if ((op >= 0x52 && op <= 0x6d)) return 'field';
  if ((op >= 0x6e && op <= 0x72) || (op >= 0x74 && op <= 0x78) || op === 0xfa || op === 0xfb) return 'method';
  return undefined;
}
