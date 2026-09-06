import { describe, expect, it } from 'vitest';
import { duration, short } from './format';

describe('short', () => {
  it('leaves a whole number whole', () => {
    expect(short(22)).toBe('22');
    expect(short(101325)).toBe('101325');
  });

  // Two decimals is the most a note can carry without the numbers running into each other, and
  // the most a reading of the shape needs: this is a summary, not the reading itself.
  it('holds a fraction to two decimals', () => {
    expect(short(1.4142)).toBe('1.41');
    expect(short(22.456)).toBe('22.46');
  });

  it('drops a trailing zero rather than printing it', () => {
    expect(short(22.5)).toBe('22.5');
    expect(short(22.1)).toBe('22.1');
  });

  // Past a hundred the decimals are noise beside the number carrying them.
  it('rounds a large number to whole units', () => {
    expect(short(1234.56)).toBe('1235');
  });

  // Under one, two decimals would round a real reading away to nothing.
  it('keeps three figures of a small number', () => {
    expect(short(0.0012345)).toBe('0.00123');
    expect(short(0.5)).toBe('0.5');
  });

  it('keeps a negative negative', () => {
    expect(short(-3.257)).toBe('-3.26');
  });
});

describe('duration', () => {
  it('counts a short wait in milliseconds', () => {
    expect(duration(620)).toBe('620 ms');
  });

  it('counts a wait of seconds in seconds', () => {
    expect(duration(1000)).toBe('1 s');
    expect(duration(1500)).toBe('1.5 s');
  });

  it('counts a long wait in minutes', () => {
    expect(duration(90_000)).toBe('1.5 min');
  });
});

/**
 * The far end of the scale, which a JSON body reaches without trying: one topic sending
 * `{"buyuk": 1e308}` put `1.6666666666666666e+307` under a chart as an axis label.
 */
describe('short, past where a double stops writing digits', () => {
  it('gives three figures and an exponent rather than every figure it holds', () => {
    expect(short(1.6666666666666666e307)).toBe('1.67e+307');
    expect(short(-1.6666666666666666e307)).toBe('-1.67e+307');
  });

  it('leaves no trailing zeros on the mantissa', () => {
    expect(short(1e308)).toBe('1e+308');
    expect(short(1e21)).toBe('1e+21');
    expect(short(1.5e22)).toBe('1.5e+22');
  });

  it('still writes the ordinary sizes the way it always did', () => {
    expect(short(1e20)).toBe('100000000000000000000');
    expect(short(12345)).toBe('12345');
    expect(short(21.53)).toBe('21.53');
  });

  it('says the small end in figures a reader can count', () => {
    expect(short(5e-324)).toBe('4.94e-324');
  });
});
