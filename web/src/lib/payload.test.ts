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
