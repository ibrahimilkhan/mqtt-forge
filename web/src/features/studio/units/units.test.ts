import { describe, expect, it } from 'vitest';
import { formatAngle, formatLength, fromDisplay, roundTo, toDisplay } from './units';

describe('display units', () => {
  it('turns metres into the unit on show and back', () => {
    expect(toDisplay(0.0125, 'mm')).toBeCloseTo(12.5);
    expect(fromDisplay(12.5, 'mm')).toBeCloseTo(0.0125);
    expect(toDisplay(0.0254, 'in')).toBeCloseTo(1);
  });

  // DesignBox had three length formatters and two of them ignored the chosen unit, so the HUD
  // and the inspector disagreed about the same distance.
  it('writes a length in the chosen unit, without trailing zeros', () => {
    expect(formatLength(0.0125, 'mm')).toBe('12.5 mm');
    expect(formatLength(1.5, 'm')).toBe('1.5 m');
    expect(formatLength(0.0254, 'in')).toBe('1 in');
    expect(formatLength(0.123456, 'cm', 1)).toBe('12.3 cm');
  });

  it('rounds to a number of digits', () => {
    expect(roundTo(1.23456, 2)).toBe(1.23);
  });

  it('writes an angle in degrees', () => {
    expect(formatAngle(Math.PI / 2)).toBe('90°');
  });
});
