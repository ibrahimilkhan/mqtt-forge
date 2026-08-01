import { describe, expect, it } from 'vitest';
import { sanitize } from './appearanceStore';

const DEFAULTS = { sans: 'inter', mono: 'jetbrains', size: 15 };

describe('sanitize', () => {
  it('falls back to the defaults when an id is not in the catalogue', () => {
    expect(sanitize({ sans: 'comic', mono: 'nope', size: 15 })).toEqual(DEFAULTS);
  });

  it('clamps a size that sits outside the allowed range', () => {
    expect(sanitize({ ...DEFAULTS, size: 99 }).size).toBe(20);
    expect(sanitize({ ...DEFAULTS, size: 2 }).size).toBe(12);
  });

  it('rounds a fractional size to a whole pixel', () => {
    expect(sanitize({ ...DEFAULTS, size: 16.4 }).size).toBe(16);
  });

  it('falls back to the default size when the value is not a number', () => {
    expect(sanitize({ ...DEFAULTS, size: '16' }).size).toBe(15);
    expect(sanitize({ ...DEFAULTS, size: Number.NaN }).size).toBe(15);
  });

  it('returns the defaults for anything that is not a plain object', () => {
    for (const raw of [null, undefined, 3, 'x', []]) {
      expect(sanitize(raw)).toEqual(DEFAULTS);
    }
  });
});
