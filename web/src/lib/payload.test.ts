import { describe, expect, it } from 'vitest';
import {
  byteLength,
  checkJson,
  encodePayload,
  formatJson,
  hexFromBase64,
  parseHex,
} from './payload';

describe('parseHex', () => {
  it('reads bytes written with spaces', () => {
    expect(parseHex('01 A4 FF')).toEqual({ ok: true, bytes: new Uint8Array([0x01, 0xa4, 0xff]) });
  });

  it('reads bytes written without spaces, in either case', () => {
    expect(parseHex('01a4ff')).toEqual({ ok: true, bytes: new Uint8Array([0x01, 0xa4, 0xff]) });
  });

  it('ignores newlines, so a block pasted from a datasheet works', () => {
    expect(parseHex('01 A4\nFF')).toEqual({ ok: true, bytes: new Uint8Array([0x01, 0xa4, 0xff]) });
  });

  it('reads an empty box as no bytes', () => {
    expect(parseHex('   ')).toEqual({ ok: true, bytes: new Uint8Array() });
  });

  it('names the character that is not a hex digit', () => {
    const result = parseHex('01 Z4');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Z');
  });

  it('refuses a half-written byte', () => {
    const result = parseHex('01 A4 F');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/two digits/i);
  });
});

describe('checkJson', () => {
  it('passes valid JSON', () => {
    expect(checkJson('{"a":1}')).toBeNull();
  });

  it('reports why broken JSON is broken', () => {
    expect(checkJson('{"a":}')).toBeTruthy();
  });

  it('refuses an empty body, which is not a JSON document', () => {
    expect(checkJson('  ')).toBeTruthy();
  });

  it('says which line and column the fault is on', () => {
    expect(checkJson('{\n  "a" 1\n}')).toMatch(/^Line 2, column 7:/);
  });

  it('names a property name left unquoted', () => {
    expect(checkJson('{ a: 1 }')).toMatch(/double quotes/i);
  });

  it('names single quotes, which JSON does not take', () => {
    expect(checkJson("{ 'a': 1 }")).toMatch(/not single/i);
  });

  it('points at the comma left after the last entry', () => {
    expect(checkJson('{ "a": 1, }')).toBe('Line 1, column 9: there is a comma after the last entry.');
  });

  it('points at the comma left after the last item', () => {
    expect(checkJson('[1, 2, ]')).toMatch(/comma after the last item/);
  });

  it('names a comma missing between entries', () => {
    expect(checkJson('{ "a": 1 "b": 2 }')).toMatch(/','/);
  });

  it('points at the quote that opened a string never closed', () => {
    expect(checkJson('{ "a": "x }')).toBe('Line 1, column 8: this string is never closed.');
  });

  it('points at the brace that opened an object never closed', () => {
    expect(checkJson('{ "a": 1')).toBe('Line 1, column 1: this object is never closed.');
  });

  it('points at the bracket that opened an array never closed', () => {
    expect(checkJson('[1, 2')).toMatch(/^Line 1, column 1: this array is never closed\./);
  });

  it('names a word that is not a JSON value', () => {
    expect(checkJson('{ "a": NaN }')).toMatch(/'NaN'/);
  });

  it('names text left after the end of the document', () => {
    expect(checkJson('{"a":1} and more')).toMatch(/after the end/i);
  });

  it('names a template placeholder rather than blaming its braces', () => {
    expect(checkJson('{ "id": {{deviceId}} }')).toMatch(/placeholder/i);
  });

  it('accepts every document JSON.parse accepts', () => {
    const good = [
      'null',
      'true',
      '-0.5',
      '1e-3',
      '"\\u00e7"',
      '"a\\nb"',
      '[]',
      '{}',
      '  {"a": [1, 2, {"b": null}]}  ',
      '{"a": {"b": {"c": []}}}',
    ];

    for (const text of good) expect([text, checkJson(text)]).toEqual([text, null]);
  });

  it('refuses every document JSON.parse refuses', () => {
    const bad = [
      '{',
      '}',
      '[1,]',
      '[,1]',
      '{"a" 1}',
      '{"a": 1,, "b": 2}',
      "'a'",
      '01',
      '1.',
      '.5',
      '+1',
      'True',
      'undefined',
      '"a\nb"',
      '"\\q"',
      '"\\u00g0"',
      '{"a": 1} {"b": 2}',
    ];

    for (const text of bad) expect([text, checkJson(text)]).not.toEqual([text, null]);
  });
});

describe('formatJson', () => {
  it('indents what it is given', () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});

describe('byteLength', () => {
  it('counts bytes, not characters', () => {
    expect(byteLength('ö')).toBe(2);
    expect(byteLength('abc')).toBe(3);
  });

  it('counts the same as encoding would', () => {
    const encoder = new TextEncoder();
    const cases = [
      '',
      'plain ascii',
      '{"temp":21.4,"unit":"°C"}',
      'ölçüm',
      '€100',
      '☃',
      '😀 done',
      '𐍈',
      // Half of a pair with nothing after it, and one with the wrong thing after it: both are
      // written out as the replacement character, and both used to be able to walk past a
      // character that was never part of the pair.
      '\ud800',
      '\ud800ö',
      '\udc00',
      'a😀b',
    ];

    for (const text of cases) {
      expect([text, byteLength(text)]).toEqual([text, encoder.encode(text).length]);
    }
  });
});

describe('encodePayload', () => {
  it('sends text as it was typed', () => {
    expect(encodePayload('text', '23.5')).toEqual({
      ok: true,
      payload: '23.5',
      payloadEncoding: 'text',
      size: 4,
    });
  });

  it('sends valid JSON as text', () => {
    expect(encodePayload('json', '{"a":1}')).toEqual({
      ok: true,
      payload: '{"a":1}',
      payloadEncoding: 'text',
      size: 7,
    });
  });

  it('refuses broken JSON instead of sending it', () => {
    expect(encodePayload('json', '{"a":}').ok).toBe(false);
  });

  it('sends hex as base64, counting the bytes it stands for', () => {
    expect(encodePayload('hex', '01 A4 FF')).toEqual({
      ok: true,
      payload: 'AaT/',
      payloadEncoding: 'base64',
      size: 3,
    });
  });

  it('refuses hex it cannot read', () => {
    expect(encodePayload('hex', 'ZZ').ok).toBe(false);
  });
});

describe('hexFromBase64', () => {
  it('renders bytes as upper-case pairs a human can read', () => {
    expect(hexFromBase64('AaT/')).toEqual({ text: '01 A4 FF', size: 3 });
  });

  it('round-trips through the parser', () => {
    const { text } = hexFromBase64('AaT/');

    expect(parseHex(text)).toEqual({ ok: true, bytes: new Uint8Array([0x01, 0xa4, 0xff]) });
  });
});
