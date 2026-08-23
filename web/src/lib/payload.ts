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

/**
 * Byte length, not character length — accented text is longer on the wire.
 *
 * Counted rather than encoded. TextEncoder answers by building the bytes and then throwing them
 * away, and this runs on every arrival: measured over two hundred thousand of Helsinki's
 * messages, encoding them cost 334ms where counting costs 78. The answer is the same one — the
 * two agree on every string, including the pairs and the strays below.
 */
export function byteLength(text: string): number {
  // Every unit is at least one byte, so the loop only has to add what each one costs beyond that.
  let bytes = text.length;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue;

    if (code < 0x800) {
      bytes += 1;
      continue;
    }

    // A character outside the basic plane arrives as two units carrying four bytes between them.
    if (code >= 0xd800 && code < 0xdc00) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        bytes += 2;
        i++;
        continue;
      }
    }

    // Three bytes: the rest of the basic plane, and a half of a pair with no partner — which
    // the encoder writes as the replacement character, itself three bytes.
    bytes += 2;
  }

  return bytes;
}

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

// Built once, not per byte: this runs on every arriving binary message, and a lookup beats
// formatting the same 256 possible outputs over and over.
const HEX_BYTE = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0').toUpperCase());

/** Upper case and space separated: the form the parser above reads back unchanged. */
export function hexFromBase64(base64: string): { text: string; size: number } {
  const binary = atob(base64);
  const pairs: string[] = [];
  for (let i = 0; i < binary.length; i++) {
    pairs.push(HEX_BYTE[binary.charCodeAt(i)]);
  }

  return { text: pairs.join(' '), size: binary.length };
}

/** Null when the text is a JSON document; otherwise where it stops being one, and why. */
export function checkJson(text: string): string | null {
  if (text.trim() === '') return 'A JSON body cannot be empty.';

  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    // JSON.parse stays the judge of valid and invalid; the scan below only explains its verdict,
    // because the engines word that verdict differently and none of them word it for a person.
    const fault = findFault(text);
    if (fault) {
      const { line, column } = lineColumn(text, fault.at);
      return `Line ${line}, column ${column}: ${fault.why}`;
    }

    return error instanceof Error ? error.message : 'This is not valid JSON.';
  }
}

type Fault = { at: number; why: string };

class Stop extends Error {
  readonly fault: Fault;

  constructor(fault: Fault) {
    super(fault.why);
    this.fault = fault;
  }
}

/**
 * The first place the text stops being JSON, in the words someone typing it would use.
 *
 * Only ever runs on text JSON.parse has already rejected, so it does not have to be fast, and
 * it may return null: an unexplained fault falls back to the engine's own message.
 */
function findFault(text: string): Fault | null {
  let i = 0;

  const stop = (why: string, at = i): never => {
    throw new Stop({ at, why });
  };
  const here = (): string | undefined => text[i];
  const skipSpace = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };

  function value(): void {
    skipSpace();
    if (i >= text.length) stop('the body ends where a value should be.');

    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    if (c === "'") stop('JSON strings go in double quotes, not single.');
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    return word();
  }

  function object(): void {
    const open = i;
    i++;
    skipSpace();
    if (here() === '}') {
      i++;
      return;
    }

    for (;;) {
      skipSpace();
      if (i >= text.length) stop('this object is never closed.', open);
      // A doubled brace here is almost always a {{placeholder}} pasted from a template, so say
      // that rather than complaining about a property name that was never meant to be one.
      if (here() === '{') stop('a {{...}} placeholder is not JSON; send it as Text.', i);
      if (here() === "'") stop('property names go in double quotes, not single.');
      if (here() !== '"') stop('property names go in double quotes.');
      string();

      skipSpace();
      if (i >= text.length) stop('this object is never closed.', open);
      if (here() !== ':') stop("a ':' should come after the property name.");
      i++;
      value();

      skipSpace();
      if (i >= text.length) stop('this object is never closed.', open);
      if (here() === '}') {
        i++;
        return;
      }
      if (here() !== ',') stop("a ',' is missing between entries.");

      const comma = i;
      i++;
      skipSpace();
      if (here() === '}') stop('there is a comma after the last entry.', comma);
    }
  }

  function array(): void {
    const open = i;
    i++;
    skipSpace();
    if (here() === ']') {
      i++;
      return;
    }

    for (;;) {
      value();

      skipSpace();
      if (i >= text.length) stop('this array is never closed.', open);
      if (here() === ']') {
        i++;
        return;
      }
      if (here() !== ',') stop("a ',' is missing between items.");

      const comma = i;
      i++;
      skipSpace();
      if (here() === ']') stop('there is a comma after the last item.', comma);
    }
  }

  function string(): void {
    const open = i;
    i++;

    for (;;) {
      if (i >= text.length) stop('this string is never closed.', open);

      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }

      if (c === '\\') {
        const escape = text[i + 1];
        if (escape === undefined) stop('this string is never closed.', open);
        if (escape === 'u') {
          const digits = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) stop("a '\\u' escape takes four hex digits.", i);
          i += 6;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) stop(`'\\${escape}' is not a JSON escape.`, i);
        i += 2;
        continue;
      }

      // A line break inside quotes is the usual one: JSON has no multi-line string literal.
      if (c < ' ') stop('a string cannot hold a raw line break or control character.');
      i++;
    }
  }

  const digit = (): boolean => {
    const c = here();
    return c !== undefined && c >= '0' && c <= '9';
  };

  function number(): void {
    const start = i;
    if (here() === '-') i++;

    if (here() === '0') {
      i++;
    } else {
      if (!digit()) stop('a number needs a digit here.', start);
      while (digit()) i++;
    }
    if (digit()) stop('a number cannot start with 0.', start);

    if (here() === '.') {
      i++;
      if (!digit()) stop('a number needs a digit after the decimal point.', start);
      while (digit()) i++;
    }

    if (here() === 'e' || here() === 'E') {
      i++;
      if (here() === '+' || here() === '-') i++;
      if (!digit()) stop('an exponent needs a digit.', start);
      while (digit()) i++;
    }
  }

  /** true, false and null — or whatever was written where one of them belongs. */
  function word(): void {
    const start = i;
    while (i < text.length && /[A-Za-z]/.test(text[i])) i++;

    const written = text.slice(start, i);
    if (written === 'true' || written === 'false' || written === 'null') return;
    if (written === '') stop(`'${text[start]}' is not where a value can start.`, start);
    stop(`'${written}' is not a JSON value.`, start);
  }

  try {
    value();
    skipSpace();
    if (i < text.length) stop('there is more text after the end of the document.');
    return null;
  } catch (error) {
    // Nesting deep enough to exhaust the stack is the one throw that is not ours; the engine's
    // own message stands in for it.
    return error instanceof Stop ? error.fault : null;
  }
}

/** Both one-based, the way an editor counts them. */
function lineColumn(text: string, at: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;

  for (let i = 0; i < at; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }

  return { line, column: at - lineStart + 1 };
}

export const formatJson = (text: string): string => JSON.stringify(JSON.parse(text), null, 2);

// Built a character at a time rather than by spreading into String.fromCharCode: a firmware
// blob is long enough to blow the argument limit that way.
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
