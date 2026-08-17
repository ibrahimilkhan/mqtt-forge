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
