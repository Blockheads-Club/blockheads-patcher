import { expect, test } from 'vitest';
import { CORE_VERSION } from '../src/index';
test('core loads', () => { expect(CORE_VERSION).toBeTypeOf('string'); });
