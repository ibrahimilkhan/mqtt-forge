/**
 * MQTT payloads are bytes. This is the one place that turns what someone typed into those
 * bytes, and bytes that arrived back into something readable.
 *
 * Base64 is the only binary form the wire carries, in both directions; hex is a writing for
 * people, so it never leaves the browser.
 */

/** What the publish box is being typed into. */
export type PayloadMode = 'text' | 'json' | 'hex';

/** How a body is held once it is out of the box: JSON is text on the wire, so it is not here. */
export type BodyMode = Exclude<PayloadMode, 'json'>;

export type Encoded =
  | { ok: true; payload: string; payloadEncoding: 'text' | 'base64'; size: number }
  | { ok: false; error: string };

export type Parsed = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

const encoder = new TextEncoder();

/** Byte length, not character length — accented text is longer on the wire. */
export const byteLength = (text: string): number => encoder.encode(text).length;

export function encodePayload(mode: PayloadMode, text: string): Encoded {
  if (mode === 'hex') {
    const parsed = parseHex(text);
    if (!parsed.ok) return parsed;

    return {
      ok: true,
      payload: base64FromBytes(parsed.bytes),
      payloadEncoding: 'base64',
      size: parsed.bytes.length,
    };
  }

  if (mode === 'json') {
    const error = checkJson(text);
    if (error) return { ok: false, error };
  }

  return { ok: true, payload: text, payloadEncoding: 'text', size: byteLength(text) };
}

/** Whitespace anywhere is ignored, so a block pasted out of a datasheet parses as typed. */
export function parseHex(text: string): Parsed {
  const digits = text.replace(/\s+/g, '');
  if (digits === '') return { ok: true, bytes: new Uint8Array() };

  const stray = digits.match(/[^0-9a-fA-F]/);
  if (stray) return { ok: false, error: `'${stray[0]}' is not a hex digit.` };

  if (digits.length % 2 !== 0) {
    return { ok: false, error: 'Hex takes two digits per byte, and one digit is left over.' };
  }

  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }

  return { ok: true, bytes };
}

/** Upper case and space separated: the form the parser above reads back unchanged. */
export function hexFromBase64(base64: string): { text: string; size: number } {
  const binary = atob(base64);
  const pairs: string[] = [];
  for (let i = 0; i < binary.length; i++) {
    pairs.push(binary.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase());
  }

  return { text: pairs.join(' '), size: binary.length };
}

/** Null when the text is a JSON document; otherwise why it is not. */
export function checkJson(text: string): string | null {
  if (text.trim() === '') return 'A JSON body cannot be empty.';

  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'This is not valid JSON.';
  }
}

export const formatJson = (text: string): string => JSON.stringify(JSON.parse(text), null, 2);

// Built a character at a time rather than by spreading into String.fromCharCode: a firmware
// blob is long enough to blow the argument limit that way.
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
