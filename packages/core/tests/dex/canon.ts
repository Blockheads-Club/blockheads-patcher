/** Test-only semantic dump of a dex (all indices resolved to names) read straight from the bytes, independent of src/dex's parser. */
import { decodeAll } from '../../src/dex';

class R {
  constructor(readonly b: Uint8Array, public p = 0) {}
  u8() { return this.b[this.p++]!; }
  u16() { const v = this.b[this.p]! | (this.b[this.p + 1]! << 8); this.p += 2; return v; }
  u32() { const v = (this.b[this.p]! | (this.b[this.p + 1]! << 8) | (this.b[this.p + 2]! << 16) | (this.b[this.p + 3]! << 24)) >>> 0; this.p += 4; return v; }
  uleb() { let r = 0, s = 0; for (;;) { const x = this.u8(); r += (x & 127) * 2 ** s; if (!(x & 128)) return r; s += 7; } }
  sleb() { let r = 0, s = 0, x = 0; do { x = this.u8(); r += (x & 127) * 2 ** s; s += 7; } while (x & 128); return x & 64 ? r - 2 ** s : r; }
}

export function canon(b: Uint8Array): string[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hdr = (o: number) => dv.getUint32(o, true);
  const [nS, oS, nT, oT, nP, oP, nF, oF, nM, oM, nC, oC] = [0x38, 0x3c, 0x40, 0x44, 0x48, 0x4c, 0x50, 0x54, 0x58, 0x5c, 0x60, 0x64].map(hdr) as number[];
  const strs: string[] = [];
  for (let i = 0; i < nS!; i++) {
    const r = new R(b, hdr(oS! + 4 * i)); r.uleb();
    const end = b.indexOf(0, r.p);
    strs.push(new TextDecoder('utf-8').decode(b.subarray(r.p, end)).replace(/\u0000/g, '\\0'));
  }
  const typeStr = (i: number) => strs[hdr(oT! + 4 * i)]!;
  const tl = (off: number) => { if (!off) return []; const r = new R(b, off); const n = r.u32(); return Array.from({ length: n }, () => typeStr(r.u16())); };
  const proto = (i: number) => { const r = new R(b, oP! + 12 * i); r.u32(); const ret = typeStr(r.u32()); return `${ret}(${tl(r.u32()).join('')})`; };
  const field = (i: number) => { const r = new R(b, oF! + 8 * i); const c = r.u16(), t = r.u16(), n = r.u32(); return `${typeStr(c)}.${strs[n]}:${typeStr(t)}`; };
  const meth = (i: number) => { const r = new R(b, oM! + 8 * i); const c = r.u16(), p = r.u16(), n = r.u32(); return `${typeStr(c)}.${strs[n]}${proto(p)}`; };
  const opt = (v: number, f: (i: number) => string) => (v === 0xffffffff ? '-' : f(v));
  const p1 = (v: number, f: (i: number) => string) => (v === 0 ? '-' : f(v - 1));

  const val = (r: R): string => {
    const h = r.u8(), t = h & 31, a = h >> 5;
    const num = () => { let v = 0; for (let i = 0; i <= a; i++) v += r.u8() * 2 ** (8 * i); return v; };
    const raw = () => Array.from({ length: a + 1 }, () => r.u8()).join('.');
    switch (t) {
      case 0: case 2: case 3: case 4: case 6: return `n${t}:${raw()}`;
      case 0x10: case 0x11: return `f${t}:${raw()}`;
      case 0x15: return `proto:${proto(num())}`;
      case 0x16: return `handle:${num()}`;
      case 0x17: return `str:${JSON.stringify(strs[num()])}`;
      case 0x18: return `type:${typeStr(num())}`;
      case 0x19: return `field:${field(num())}`;
      case 0x1a: return `method:${meth(num())}`;
      case 0x1b: return `enum:${field(num())}`;
      case 0x1c: { const n = r.uleb(); return `[${Array.from({ length: n }, () => val(r)).join(',')}]`; }
      case 0x1d: return `@${ann(r)}`;
      case 0x1e: return 'null';
      default: return a ? 'true' : 'false';
    }
  };
  const ann = (r: R): string => { const t = typeStr(r.uleb()); const n = r.uleb(); return `${t}(${Array.from({ length: n }, () => `${strs[r.uleb()]}=${val(r)}`).join(',')})`; };
  const annSet = (off: number): string[] => {
    if (!off) return [];
    const r = new R(b, off); const n = r.u32();
    return Array.from({ length: n }, () => { const a = new R(b, r.u32()); const vis = a.u8(); return `${vis}:${ann(a)}`; });
  };
  const debug = (off: number): string => {
    const r = new R(b, off);
    const out = [`line=${r.uleb()}`];
    const n = r.uleb();
    out.push(`params=[${Array.from({ length: n }, () => p1(r.uleb(), (i) => strs[i]!)).join(',')}]`);
    for (;;) {
      const op = r.u8();
      if (op === 0) break;
      if (op === 1) out.push(`pc+${r.uleb()}`);
      else if (op === 2) out.push(`line+${r.sleb()}`);
      else if (op === 3 || op === 4) {
        const reg = r.uleb(); const nm = p1(r.uleb(), (i) => strs[i]!); const ty = p1(r.uleb(), typeStr);
        out.push(op === 3 ? `local v${reg} ${nm} ${ty}` : `local v${reg} ${nm} ${ty} ${p1(r.uleb(), (i) => strs[i]!)}`);
      } else if (op === 5 || op === 6) out.push(`${op === 5 ? 'end' : 'restart'} v${r.uleb()}`);
      else if (op === 9) out.push(`file ${p1(r.uleb(), (i) => strs[i]!)}`);
      else out.push(`op${op}`);
    }
    return out.join(' ');
  };
  const code = (off: number): string[] => {
    const r = new R(b, off);
    const regs = r.u16(), ins = r.u16(), outs = r.u16(), nt = r.u16(), dbg = r.u32(), size = r.u32();
    const u = new Uint16Array(size);
    for (let i = 0; i < size; i++) u[i] = r.u16();
    const lines = [`code regs=${regs} ins=${ins} outs=${outs} dbg=${dbg ? debug(dbg) : '-'}`];
    for (const i of decodeAll(u)) {
      const refPos = i.ref ? (i.format === '31c' || i.format === '21c' ? 1 : i.format === '22c' ? 2 : 0) : -1;
      const ops = i.operands.filter((_, k) => k !== refPos).join(',');
      const txt = i.ref ? ({ string: (x: number) => JSON.stringify(strs[x]), type: typeStr, field, method: meth }[i.ref.kind])(i.ref.index) : '';
      lines.push(`  ${i.at}: ${i.name} ${ops} ${txt}${i.wide !== undefined ? ' ' + i.wide : ''}`.trimEnd());
      if (i.op === -1) lines.push(`    payload ${Array.from(u.subarray(i.at, i.at + i.size)).join(',')}`);
    }
    if (nt) {
      if (size % 2) r.u16();
      const tries = Array.from({ length: nt }, () => ({ s: r.u32(), c: r.u16(), o: r.u16() }));
      const base = r.p; const n = r.uleb();
      const hs = new Map<number, string>();
      for (let k = 0; k < n; k++) {
        const at = r.p - base; const sz = r.sleb();
        const cs = Array.from({ length: Math.abs(sz) }, () => `${typeStr(r.uleb())}->${r.uleb()}`);
        if (sz <= 0) cs.push(`any->${r.uleb()}`);
        hs.set(at, cs.join(';'));
      }
      tries.forEach((t) => lines.push(`  try ${t.s}+${t.c} ${hs.get(t.o)}`));
    }
    return lines;
  };

  const out: string[] = [];
  for (let i = 0; i < nC!; i++) {
    const r = new R(b, oC! + 32 * i);
    const type = r.u32(), flags = r.u32(), sup = r.u32(), io = r.u32(), src = r.u32(), ao = r.u32(), co = r.u32(), so = r.u32();
    out.push(`class ${typeStr(type)} flags=${flags} super=${opt(sup, typeStr)} ifaces=[${tl(io).join(',')}] source=${opt(src, (x) => strs[x]!)}`);
    if (ao) {
      const a = new R(b, ao); const cs = a.u32(), nf = a.u32(), nm = a.u32(), np = a.u32();
      annSet(cs).forEach((x) => out.push(`  ann ${x}`));
      for (let k = 0; k < nf; k++) { const f = a.u32(); annSet(a.u32()).forEach((x) => out.push(`  fann ${field(f)} ${x}`)); }
      for (let k = 0; k < nm; k++) { const m = a.u32(); annSet(a.u32()).forEach((x) => out.push(`  mann ${meth(m)} ${x}`)); }
      for (let k = 0; k < np; k++) {
        const m = a.u32(); const l = new R(b, a.u32()); const n = l.u32();
        for (let j = 0; j < n; j++) annSet(l.u32()).forEach((x) => out.push(`  pann ${meth(m)}#${j} ${x}`));
      }
    }
    if (so) { const v = new R(b, so); const n = v.uleb(); out.push(`  values ${Array.from({ length: n }, () => val(v)).join(' ')}`); }
    if (co) {
      const d = new R(b, co);
      const counts = [d.uleb(), d.uleb(), d.uleb(), d.uleb()];
      ['sfield', 'ifield', 'direct', 'virtual'].forEach((kind, ki) => {
        let idx = 0;
        for (let k = 0; k < counts[ki]!; k++) {
          idx += d.uleb(); const fl = d.uleb();
          if (ki < 2) out.push(`  ${kind} ${field(idx)} flags=${fl}`);
          else {
            const c = d.uleb();
            out.push(`  ${kind} ${meth(idx)} flags=${fl}`);
            if (c) code(c).forEach((l) => out.push(`    ${l}`));
          }
        }
      });
    }
  }
  return out;
}
