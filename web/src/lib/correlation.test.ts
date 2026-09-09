import { describe, expect, it } from 'vitest';
import { correlationText } from './correlation';

const base64 = (...bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('correlationText', () => {
  it('reads the request id the bytes spell', () => {
    expect(correlationText(btoa('istek-42'))).toBe('istek-42');
  });

  it('reads it as hex when the bytes are not text at all', () => {
    expect(correlationText(base64(0x00, 0x01, 0xff))).toBe('00 01 ff');
  });

  // Valid UTF-8 and still not a string anybody can compare by eye.
  it('reads it as hex when the text is control characters', () => {
    expect(correlationText(base64(0x01, 0x02))).toBe('01 02');
  });

  it('keeps whatever it was handed when that was not base64', () => {
    expect(correlationText('not base64 !!')).toBe('not base64 !!');
  });

  it('has nothing to say about an empty one', () => {
    expect(correlationText('')).toBe('');
  });
});
