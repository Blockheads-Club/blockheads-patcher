import { describe, expect, test } from 'vitest';
import type { ApplicableReport } from '@bh-patcher/core';
import { displayOrder } from './patch-order';

const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({ patch: { id, ...extra }, status: 'notApplied' }) as unknown as ApplicableReport[number];

describe('displayOrder', () => {
  test('mod loader first, then recommended, optional and pack patches, each in registry order', () => {
    const report = [row('a', { optIn: true }), row('b'), row('p', { source: { kind: 'pack' } }), row('mod-loader'), row('c'), row('d', { optIn: true })];
    expect(displayOrder(report).map((r) => r.patch.id)).toEqual(['mod-loader', 'b', 'c', 'a', 'd', 'p']);
    expect(report.map((r) => r.patch.id)).toEqual(['a', 'b', 'p', 'mod-loader', 'c', 'd']);
  });
});
