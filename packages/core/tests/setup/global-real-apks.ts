/**
 * Vitest globalSetup: opens each user-owned game APK once per run and hands every test worker the JAR (v1) digests of
 * its entries, so the many real-APK patch tests do not each inflate and hash ~150 MB again (see seed-real-apks.ts).
 *
 * Digests are facts about the APK bytes, so they are cached on disk in ~/.cache/bh-patcher (or $BH_PATCHER_CACHE) keyed
 * by the APK's SHA-256. They are computed with Node's own zlib and crypto, independently of the code under test; the
 * patched outputs are still checked by apksigner, which recomputes every digest.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { TestProject } from 'vitest/node';
import { readZip } from '../../src/zip';
import { sourceOffsets } from '../../src/zip/types';
import { REAL_APKS, haveApk } from '../helpers';

export interface RealApkDigests { sha256: string; digests: Record<'SHA-256' | 'SHA1', [number, string][]> }

declare module 'vitest' {
  export interface ProvidedContext { realApkDigests: RealApkDigests[] }
}

const cacheDir = (): string => process.env.BH_PATCHER_CACHE ?? join(homedir(), '.cache', 'bh-patcher');

function digestsOf(bytes: Uint8Array, sha256: string): RealApkDigests {
  const file = join(cacheDir(), `v1-digests-${sha256}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as RealApkDigests;
  const out: RealApkDigests = { sha256, digests: { 'SHA-256': [], SHA1: [] } };
  for (const e of readZip(bytes).entries) {
    const raw = e.raw!;
    const data = e.method === 0 ? raw.compressed : inflateRawSync(raw.compressed);
    const off = sourceOffsets.get(e)!;
    out.digests['SHA-256'].push([off, createHash('sha256').update(data).digest('base64')]);
    out.digests.SHA1.push([off, createHash('sha1').update(data).digest('base64')]);
  }
  mkdirSync(cacheDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, file);
  return out;
}

export default function setup(project: TestProject): void {
  const all: RealApkDigests[] = [];
  for (const path of new Set(Object.values(REAL_APKS))) {
    if (!haveApk(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    all.push(digestsOf(bytes, createHash('sha256').update(bytes).digest('hex')));
  }
  project.provide('realApkDigests', all);
}
