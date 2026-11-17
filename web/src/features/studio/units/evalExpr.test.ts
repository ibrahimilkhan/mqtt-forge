import { describe, expect, it } from 'vitest';
import { evalExpr } from './evalExpr';

describe('evalExpr', () => {
  it('works out arithmetic with precedence and brackets', () => {
    expect(evalExpr('1200/2')).toBe(600);
    expect(evalExpr('2*(30+15)')).toBe(90);
    expect(evalExpr('-3+5')).toBe(2);
  });

  it('reads a decimal comma as a point', () => {
    expect(evalExpr('0,5')).toBe(0.5);
  });

  it('applies a relative change to the current value', () => {
    expect(evalExpr('+50', { current: 10 })).toBe(60);
    expect(evalExpr('-=20', { current: 10 })).toBe(-10);
    expect(evalExpr('*=2', { current: 10 })).toBe(20);
    expect(evalExpr('/=4', { current: 10 })).toBe(2.5);
  });

  it('converts lengths with units into the display unit, in length fields only', () => {
    expect(evalExpr('10cm+2mm', { length: true, unit: 'mm' })).toBeCloseTo(102);
    expect(evalExpr('1in', { length: true, unit: 'mm' })).toBeCloseTo(25.4);
    expect(evalExpr('50mm', { length: false })).toBeNaN();
  });

  it('answers NaN for what it does not understand', () => {
    expect(evalExpr('')).toBeNaN();
    expect(evalExpr('2+')).toBeNaN();
    expect(evalExpr('abc')).toBeNaN();
    expect(evalExpr('1/0')).toBeNaN();
  });
});
