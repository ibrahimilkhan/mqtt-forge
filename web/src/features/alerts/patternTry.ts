import type { LogEntry } from '../../stores/logStore';
import { MAX_DEPTH, parseBody } from './payloadFields';

/**
 * What a pattern rule would say about the messages already on screen.
 *
 * The answer is only worth having if it is the engine's answer, so the text tested is the text
 * the engine tests — `PayloadValue.TryExtract` in the server, walked here step for step. A tester
 * that read a field the server cannot find would show a rule firing that never will.
 */

/**
 * The body, or the field's text: a string's contents, any other value as the payload's own text.
 * Null is 'the topic did not say', which the engine treats as a skip rather than as a miss.
 */
// A span into the raw text, not a re-rendering of the parsed value: `GetRawText` on the server
// hands back the bytes the device wrote, digits and spacing included, and a pattern is tried
// against that same text. JSON.parse (via parseBody) is kept only as the validity gate — a body
// it cannot read is still 'no document to look in' — and the walk below finds the field's own
// slice of the string instead of asking the parsed value to print itself again.
export function textAt(payload: string, field: string): string | null {
  if (field.trim() === '') return payload;

  if (parseBody(payload) === null) return null;

  const body = payload.trim();
  const span = walk(body, field);
  if (span === undefined) return null;

  const [start, end] = span;
  const slice = body.slice(start, end);

  return slice.startsWith('"') ? (JSON.parse(slice) as string) : slice;
}

/** A span `[start, end)` into `text`, locating a value without parsing it into one. */
type Span = readonly [number, number];

/**
 * `TryWalk`, stepping over spans of the raw text rather than over parsed values — the same
 * grammar: dots and brackets, an optional leading '$', at most MAX_DEPTH steps.
 */
function walk(body: string, path: string): Span | undefined {
  let text = path.trim();
  if (text.startsWith('$') && (text.length === 1 || text[1] === '.' || text[1] === '[')) {
    text = text.slice(1);
  }

  let found: Span = [0, body.length];
  let at = 0;
  let steps = 0;

  while (at < text.length) {
    if (steps > 0 && text[at] !== '.' && text[at] !== '[') return undefined;

    if (text[at] === '.') {
      at += 1;
      if (at >= text.length || text[at] === '.' || text[at] === '[') return undefined;
    }

    steps += 1;
    if (steps > MAX_DEPTH) return undefined;

    if (text[at] === '[') {
      const close = text.indexOf(']', at);
      if (close < 0) return undefined;

      const next = indexInto(body, found, text.slice(at + 1, close));
      if (next === undefined) return undefined;

      found = next;
      at = close + 1;
      continue;
    }

    const rest = text.slice(at);
    const end = rest.search(/[.[]/);
    const name = end < 0 ? rest : rest.slice(0, end);
    at = end < 0 ? text.length : at + end;

    if (body[found[0]] === '[') {
      const next = indexInto(body, found, name);
      if (next === undefined) return undefined;

      found = next;
      continue;
    }

    if (body[found[0]] !== '{') return undefined;

    const next = propertySpan(body, found, name);
    if (next === undefined) return undefined;

    found = next;
  }

  return found;
}

/** `TryIndex`: digits only, inside an array span. */
function indexInto(body: string, span: Span, digits: string): Span | undefined {
  if (body[span[0]] !== '[' || !/^[0-9]+$/.test(digits)) return undefined;

  return elementSpan(body, span, Number(digits));
}

/** The span of the object's property of that name, the last of them when there are two. */
// `JsonDocument.TryGetProperty` and `JSON.parse` both keep the last of a duplicate key, so the
// loop below never stops at the first match — it keeps overwriting `result` as it walks on.
function propertySpan(body: string, [start, end]: Span, name: string): Span | undefined {
  let at = skipWs(body, start + 1, end);
  let result: Span | undefined;

  while (at < end && body[at] !== '}') {
    const keyEnd = skipString(body, at);
    const key = JSON.parse(body.slice(at, keyEnd)) as string;

    at = skipWs(body, keyEnd, end) + 1; // past the ':'
    at = skipWs(body, at, end);

    const valueStart = at;
    const valueEnd = skipValue(body, valueStart);
    if (key === name) result = [valueStart, valueEnd];

    at = skipWs(body, valueEnd, end);
    if (body[at] === ',') at = skipWs(body, at + 1, end);
  }

  return result;
}

/** The span of the array's element at that index. */
function elementSpan(body: string, [start, end]: Span, index: number): Span | undefined {
  let at = skipWs(body, start + 1, end);
  let seen = 0;

  while (at < end && body[at] !== ']') {
    const valueStart = at;
    const valueEnd = skipValue(body, valueStart);
    if (seen === index) return [valueStart, valueEnd];

    seen += 1;
    at = skipWs(body, valueEnd, end);
    if (body[at] === ',') at = skipWs(body, at + 1, end);
  }

  return undefined;
}

/** The first offset at or after `at`, before `end`, that is not whitespace. */
function skipWs(body: string, at: number, end: number): number {
  let i = at;
  while (i < end && /\s/.test(body[i])) i += 1;

  return i;
}

/** The offset just past the closing quote of the string starting at `at`. */
function skipString(body: string, at: number): number {
  let i = at + 1;
  while (i < body.length) {
    if (body[i] === '\\') {
      i += 2;
      continue;
    }
    if (body[i] === '"') return i + 1;

    i += 1;
  }

  return body.length;
}

/** The offset just past the closing bracket of the container starting at `at`. */
function skipContainer(body: string, at: number, open: string, close: string): number {
  let depth = 0;
  let i = at;

  while (i < body.length) {
    if (body[i] === '"') {
      i = skipString(body, i);
      continue;
    }
    if (body[i] === open) depth += 1;
    else if (body[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }

    i += 1;
  }

  return body.length;
}

/** The offset just past the JSON value starting at `at`: a string, an object, an array, or a bare token. */
function skipValue(body: string, at: number): number {
  const first = body[at];
  if (first === '"') return skipString(body, at);
  if (first === '{') return skipContainer(body, at, '{', '}');
  if (first === '[') return skipContainer(body, at, '[', ']');

  // A number, true, false, or null: the body is already known to parse, so scanning up to the
  // next structural character or whitespace is enough to find where the token ends.
  let i = at;
  while (i < body.length && !/[,}\]\s]/.test(body[i])) i += 1;

  return i;
}

export type Compiled = { ok: true; regex: RegExp } | { ok: false; message: string };

export function compilePattern(regex: string): Compiled {
  try {
    return { ok: true, regex: new RegExp(regex) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export type Verdict = 'fires' | 'quiet' | 'skipped';

/** The rule's answer and not the expression's: negate is applied, and a missing field skips. */
export function verdictOf(regex: RegExp, negate: boolean, text: string | null): Verdict {
  if (text === null) return 'skipped';

  return regex.test(text) !== negate ? 'fires' : 'quiet';
}

export type TriedText = { topic: string; text: string | null };

/**
 * The texts worth trying, newest first, each once.
 *
 * Distinct because a sensor saying 'ok' forty times is one row of evidence, not forty, and eight
 * rows of the same word would hide the one message that is different. Binary bodies are left out:
 * the console holds them as hex, which is not the text the engine would test.
 */
export function recentTexts(entries: readonly LogEntry[], field: string, limit = 8): TriedText[] {
  const seen = new Set<string>();
  const out: TriedText[] = [];

  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entry.kind !== 'recv' || entry.mode === 'hex' || entry.topic === undefined) continue;

    const text = textAt(entry.body ?? '', field);
    const key = `${entry.topic}\u0000${text ?? '\u0001'}`;
    if (seen.has(key)) continue;

    seen.add(key);
    out.push({ topic: entry.topic, text });
  }

  return out;
}
