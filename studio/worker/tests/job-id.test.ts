// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isValidJobId } from '../src/index.js';

describe('isValidJobId', () => {
  it('accepts the canonical form', () => expect(isValidJobId('bj_01j9zq3k4m5n6p7q8r9s0t1v2w')).toBe(true));
  it.each([
    '',
    'bj_',
    'bj_01J9ZQ3K4M5N6P7Q8R9S0T1V2W',
    'xx_01j9zq3k4m5n6p7q8r9s0t1v2w',
    'bj_01j9zq3k4m5n6p7q8r9s0t1v2il',
  ])('rejects %s', (id) => expect(isValidJobId(id)).toBe(false));
});
