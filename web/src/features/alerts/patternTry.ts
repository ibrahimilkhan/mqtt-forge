import type { LogEntry } from '../../stores/logStore';
import { MAX_DEPTH, parseBody, type Json } from './payloadFields';

/**
 * What a pattern rule would say about the messages already on screen.
 *
 * The answer is only worth having if it is the engine's answer, so the text tested is the text
 * the engine tests — `PayloadValue.TryExtract` in the server, walked here step for step. A tester
 * that read a field the server cannot find would show a rule firing that never will.
 */

/**
 * The body, or the field's text: a string's contents, any other value as JSON. Null is 'the
 * topic did not say', which the engine treats as a skip rather than as a miss.
 */
// JSON.stringify where the server keeps the raw text: the two differ only on how a number was
// written ('1.50' arrives as '1.5' here), which is a difference a pattern rule can see and nobody
// writing one is likely to be leaning on.
export function textAt(payload: string, field: string): string | null {
  if (field.trim() === '') return payload;

  const body = parseBody(payload);
  if (body === null) return null;

  const found = walk(body, field);
  if (found === undefined) return null;

  return typeof found === 'string' ? found : JSON.stringify(found);
}

/** `TryWalk`: dots and brackets, an optional leading '$', at most MAX_DEPTH steps. */
function walk(body: Json, path: string): Json | undefined {
  let text = path.trim();
  if (text.startsWith('$') && (text.length === 1 || text[1] === '.' || text[1] === '[')) {
    text = text.slice(1);
  }

  let found: Json = body;
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

      const next = indexInto(found, text.slice(at + 1, close));
      if (next === undefined) return undefined;

      found = next;
      at = close + 1;
      continue;
    }

    const rest = text.slice(at);
    const end = rest.search(/[.[]/);
    const name = end < 0 ? rest : rest.slice(0, end);
    at = end < 0 ? text.length : at + end;

    if (Array.isArray(found)) {
      const next = indexInto(found, name);
      if (next === undefined) return undefined;

      found = next;
      continue;
    }

    if (found === null || typeof found !== 'object' || !Object.prototype.hasOwnProperty.call(found, name)) return undefined;

    found = found[name];
  }

  return found;
}

/** `TryIndex`: digits only, inside the array. */
function indexInto(found: Json, digits: string): Json | undefined {
  if (!Array.isArray(found) || !/^[0-9]+$/.test(digits)) return undefined;

  const index = Number(digits);

  return index < found.length ? found[index] : undefined;
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
