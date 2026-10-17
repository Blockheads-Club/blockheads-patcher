// Benchmark: patchApk on a user-owned APK. Usage: bun scripts/bench.ts [apk]
// Reports wall time and peak RSS. Run once per process for meaningful peak numbers.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { patchApk, MemoryKeystore } from '../packages/core/src';

const path = process.argv[2] ?? `${homedir()}/Downloads/The Blockheads_1.7.4_APKPure.apk`;
if (!existsSync(path)) { console.log(`skip: ${path} not found`); process.exit(0); }
const bytes = new Uint8Array(readFileSync(path));
const mb = (n: number) => (n / 1048576).toFixed(0);
let peak = process.memoryUsage().rss;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
const t0 = performance.now();
const res = await patchApk(bytes, { patchIds: ['fix-welcome-popup-deadlock'], keystore: new MemoryKeystore() });
const ms = performance.now() - t0;
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().rss);
console.log(JSON.stringify({ input_mb: +mb(bytes.length), output_mb: +mb(res.bytes.length), time_ms: Math.round(ms), peak_rss_mb: +mb(peak), applied: res.applied }));
