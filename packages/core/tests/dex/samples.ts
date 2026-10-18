import { buildDex, type ClsSpec, type DexSpec, type Unit } from './fixture';

const OBJ = 'Ljava/lang/Object;', STR = 'Ljava/lang/String;';
export const BASE = 'Lcom/ex/Base;', DERIVED = 'Lcom/ex/Derived;', IFACE = 'Lcom/ex/Iface;', ANN = 'Lcom/ex/Ann;';

const objInit: Unit = { m: [OBJ, '<init>', 'V', []] };

/** A dex that exercises every item kind the editor must preserve: annotations, static values, debug info, try/catch, payloads. */
export function richSpec(): DexSpec {
  const base: ClsSpec = {
    name: BASE, flags: 1, ifaces: ['Ljava/lang/Runnable;'], source: 'Base.java',
    sfields: [{ name: 'COUNT', type: 'I', flags: 0x19 }, { name: 'NAME', type: STR, flags: 0x19 }],
    ifields: [{ name: 'label', type: STR, flags: 2 }, { name: 'n', type: 'J', flags: 1 }],
    values: [{ k: 'int', v: 7 }, { k: 'string', ref: { s: 'base-name' } }],
    ann: {
      cls: [{ vis: 1, a: { type: ANN, elems: [
        ['value', { k: 'string', ref: { s: 'x' } }], ['arr', { k: 'array', v: [{ k: 'int', v: 1 }, { k: 'byte', v: 2 }, { k: 'null' }] }],
        ['nested', { k: 'annotation', a: { type: ANN, elems: [['flag', { k: 'bool', v: true }]] } }],
        ['en', { k: 'enum', ref: { f: [BASE, 'COUNT', 'I'] } }], ['t', { k: 'type', ref: { t: DERIVED } }],
        ['m', { k: 'method', ref: { m: [BASE, 'run', 'V', []] } }], ['f', { k: 'field', ref: { f: [BASE, 'NAME', STR] } }],
        ['p', { k: 'proto', ref: { p: ['V', []] } }], ['h', { k: 'handle', idx: 0 }],
      ] } }],
      fields: { [`label:${STR}`]: [{ vis: 0, a: { type: ANN, elems: [['value', { k: 'string', ref: { s: 'lbl' } }]] } }] },
      methods: { run: [{ vis: 2, a: { type: ANN, elems: [] } }] },
      params: { 'setLabel': [[{ vis: 1, a: { type: ANN, elems: [['value', { k: 'char', v: 65 }]] } }], []] },
    },
    direct: [{
      name: '<init>', ret: 'V', params: [], flags: 0x10001,
      code: {
        regs: 1, ins: 1, outs: 1, insns: [0x1070, objInit, 0x0000, 0x000e],
        debug: { line: 10, params: [], ops: [['prologue'], ['startLocal', 0, 'this', BASE], ['advancePc', 2], ['special', 0x4b], ['endLocal', 0], ['restart', 0], ['epilogue'], ['setFile', 'Other.java'], ['advanceLine', -3], ['startLocalExt', 0, 'this', BASE, 'sig'], ['special', 0x14]] },
      },
    }],
    virtual: [
      {
        name: 'run', ret: 'V', params: [], flags: 1,
        code: {
          regs: 5, ins: 1, outs: 3,
          insns: [
            0x001a, { s: 'hello' },                                        // 0 const-string v0
            0x0162, { f: [BASE, 'NAME', STR] },                            // 2 sget-object v1
            0x0222, { t: DERIVED },                                        // 4 new-instance v2
            0x031b, { s: 'wide string', wide: true },                      // 6 const-string/jumbo v3
            0x206e, { m: [STR, 'equals', 'Z', [OBJ]] }, 0x0010,            // 9 invoke-virtual {v0, v1}
            0x1020, { t: BASE },                                           // 12 instance-of v0, v1
            0x001f, { t: STR },                                            // 14 check-cast v0
            0x1023, { t: '[I' },                                           // 16 new-array v0, v1
            0x1052, { f: [BASE, 'n', 'J'] },                               // 18 iget v0, v1
            0x001c, { t: DERIVED },                                        // 20 const-class v0
            0x1024, { t: '[I' }, 0x0000,                                   // 22 filled-new-array {v0}
            0x0038, 0x0003,                                                // 25 if-eqz v0, +3
            0x0228,                                                        // 27 goto +2
            0x0000,                                                        // 28 nop
            0x0018, 0x1111, 0x2222, 0x3333, 0x4444,                        // 29 const-wide v0
            0x002b, 0x0004, 0x0000, 0x0000,                                // 34 packed-switch v0 -> payload at 38
            0x0100, 0x0001, 0x0001, 0x0000, 0x0005, 0x0000,                // 38 payload
            0x0026, 0x0004, 0x0000, 0x0000,                                // 44 fill-array-data -> payload at 48
            0x0300, 0x0001, 0x0003, 0x0000, 0x0201, 0x0003,                // 48 array payload (width 1, 3 elements)
            0x0200, 0x0001, 0x0007, 0x0000, 0x0004, 0x0000,                // 54 sparse payload (1 entry)
            0x000e,                                                        // 60 return-void
            0x000d,                                                        // 61 move-exception v0
            0x000e,                                                        // 62 return-void
          ],
          tries: [{ start: 0, count: 10, handler: 0 }, { start: 12, count: 8, handler: 1 }],
          handlers: [{ catches: [{ type: 'Ljava/io/IOException;', addr: 61 }, { type: 'Ljava/lang/Exception;', addr: 61 }] }, { catches: [], catchAll: 61 }],
        },
      },
      { name: 'setLabel', ret: 'V', params: [STR], flags: 1, code: { regs: 3, ins: 2, outs: 0, insns: [0x205b, { f: [BASE, 'label', STR] }, 0x000e] } },
      { name: 'abstractOne', ret: 'I', params: ['J', 'D'], flags: 0x401 },
    ],
  };
  const derived: ClsSpec = {
    name: DERIVED, flags: 1, super: BASE, source: 'Derived.java',
    values: [
      { k: 'byte', v: 1 }, { k: 'short', v: 300 }, { k: 'char', v: 66 }, { k: 'int', v: 70000 }, { k: 'long', v: 5_000_000_000n },
      { k: 'float', raw: [0, 0, 0x80, 0x3f] }, { k: 'double', raw: [0, 0, 0, 0, 0, 0, 0xf0, 0x3f] }, { k: 'null' }, { k: 'bool', v: false },
      { k: 'array', v: [{ k: 'string', ref: { s: 'in-array' } }] }, { k: 'type', ref: { t: BASE } },
    ],
    sfields: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map((n, i) => ({ name: n, type: i === 4 ? 'J' : 'I', flags: 9 })),
    virtual: [{ name: 'run', ret: 'V', params: [], flags: 1, code: { regs: 1, ins: 1, outs: 1, insns: [0x106f, { m: [BASE, 'run', 'V', []] }, 0x0000, 0x000e] } }],
  };
  const iface: ClsSpec = { name: IFACE, flags: 0x601, virtual: [{ name: 'go', ret: 'V', params: [], flags: 0x401 }] };
  const ann: ClsSpec = { name: ANN, flags: 0x2601, ifaces: ['Ljava/lang/annotation/Annotation;'], virtual: [{ name: 'value', ret: STR, params: [], flags: 0x401 }] };
  const empty: ClsSpec = { name: 'Lcom/ex/Empty;', flags: 1 };
  return { classes: [base, derived, iface, ann, empty], extraStrings: ['zzz-unused'] };
}

export const richDex = (): Uint8Array => buildDex(richSpec());
