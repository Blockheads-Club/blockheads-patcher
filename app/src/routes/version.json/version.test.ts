import { expect, test } from 'vitest';
import { GET, prerender } from './+server';

test('version.json: the build version, prerendered', async () => {
  expect(prerender).toBe(true);
  const res = GET();
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(await res.json()).toEqual({ version: __APP_VERSION__ });
});
