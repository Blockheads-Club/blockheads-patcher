import type { ProgressStage } from './state.svelte';

/** The four user-visible stages, in the order the pipeline performs them (read+parse, patch, write, sign). */
export const ROWS = ['read', 'patch', 'write', 'sign'] as const;
export type Row = (typeof ROWS)[number];

/** Number of rows fully done, given the last progress event of the pipeline (events fire when a stage completes). */
export function completedRows(stage: ProgressStage, fraction: number): number {
  switch (stage) {
    case 'read': return 0;
    case 'parse': return 1;
    case 'patch': return 2;
    case 'write': return 3;
    case 'sign': return fraction >= 1 ? 4 : 3;
    default: return 4;
  }
}

/** Overall percentage (0..100) derived from real stage events; signing reports its own fraction. */
export function overallPercent(stage: ProgressStage, fraction: number): number {
  switch (stage) {
    case 'read': return 0;
    case 'parse': return 10;
    case 'patch': return 35;
    case 'write': return 45;
    case 'sign': return Math.round(45 + 55 * Math.min(1, Math.max(0, fraction)));
    default: return 100;
  }
}
