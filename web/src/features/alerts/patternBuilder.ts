/**
 * A pattern rule written in words, and the words read back out of a pattern.
 *
 * The rule file holds a regular expression and nothing else, and that does not change here: the
 * builder is a way of writing the expression, not a second thing stored beside it. So the only
 * honest way to open a saved rule in the builder is to ask which words would have written this
 * exact expression — and when none would, to show the expression as it is. A reader who opens a
 * rule to look at it must never save it back changed.
 */
export type PatternMode = 'contains' | 'startsWith' | 'endsWith' | 'exactly' | 'anyWord' | 'regex';

export type WordMode = Exclude<PatternMode, 'regex'>;

export const PATTERN_MODES: ReadonlyArray<{ value: PatternMode; label: string }> = [
  { value: 'contains', label: 'Contains' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'endsWith', label: 'Ends with' },
  { value: 'exactly', label: 'Is exactly' },
  { value: 'anyWord', label: 'Any of these words' },
  { value: 'regex', label: 'Regular expression' },
];

/** Read in this order, so the most particular shape wins: '^a$' is exactly, not starts-with. */
const READ_ORDER: readonly WordMode[] = ['anyWord', 'exactly', 'startsWith', 'endsWith', 'contains'];

// Every character either engine reads as syntax outside a class. '-', ',' and '/' are not among
// them, and escaping them anyway would write expressions nobody reading the file expects.
const SPECIAL = new Set('\\^$.|?*+()[]{}');

const esc = (text: string): string =>
  [...text].map((character) => (SPECIAL.has(character) ? `\\${character}` : character)).join('');

/** One word to a line, trimmed, blank lines gone — as the list condition reads its textarea. */
const wordsOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * The expression a mode writes.
 *
 * No text writes no expression, in every mode. '^' alone would be a rule that matches every
 * message and passes the validator, which is the one outcome worse than a refusal.
 */
export function regexOf(mode: WordMode, text: string): string {
  if (mode === 'anyWord') {
    const words = wordsOf(text);

    return words.length === 0 ? '' : `^(?:${words.map(esc).join('|')})$`;
  }
  if (text === '') return '';

  switch (mode) {
    case 'contains':
      return esc(text);
    case 'startsWith':
      return `^${esc(text)}`;
    case 'endsWith':
      return `${esc(text)}$`;
    case 'exactly':
      return `^${esc(text)}$`;
  }
}

/**
 * Undo `esc`, or null when the text holds syntax `esc` would never have left bare.
 *
 * Strict on purpose: '\d' is not an escaped 'd', it is a digit class, and reading it as the
 * letter would put a rule into the builder that the builder then quietly rewrites.
 */
function unescape(text: string): string | null {
  let out = '';

  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];

    if (character === '\\') {
      const next = text[at + 1];
      if (next === undefined || !SPECIAL.has(next)) return null;
      out += next;
      at += 1;
    } else if (SPECIAL.has(character)) {
      return null;
    } else {
      out += character;
    }
  }

  return out;
}

/** The body of an any-word list split on its bare bars, each word unescaped. */
function unescapeWords(body: string): string[] | null {
  const words: string[] = [];
  let start = 0;

  for (let at = 0; at <= body.length; at += 1) {
    if (body[at] === '\\') {
      at += 1;
      continue;
    }
    if (at === body.length || body[at] === '|') {
      const word = unescape(body.slice(start, at));
      if (word === null) return null;
      words.push(word);
      start = at + 1;
    }
  }

  return words;
}

/** The text that writes this expression in this mode, or null when that mode cannot write it. */
export function textFor(mode: WordMode, regex: string): string | null {
  let text: string | null;

  switch (mode) {
    case 'contains':
      text = unescape(regex);
      break;
    case 'startsWith':
      text = regex.startsWith('^') ? unescape(regex.slice(1)) : null;
      break;
    case 'endsWith':
      text = regex.endsWith('$') ? unescape(regex.slice(0, -1)) : null;
      break;
    case 'exactly':
      text = regex.startsWith('^') && regex.endsWith('$') ? unescape(regex.slice(1, -1)) : null;
      break;
    case 'anyWord': {
      const words =
        regex.startsWith('^(?:') && regex.endsWith(')$') ? unescapeWords(regex.slice(4, -2)) : null;
      text = words === null ? null : words.join('\n');
      break;
    }
  }

  // Written again and compared, which is what makes 'this mode wrote it' a fact rather than a
  // guess: 'a\$' ends with a dollar and is not an ends-with, and the comparison is what says so.
  return text !== null && text !== '' && regexOf(mode, text) === regex ? text : null;
}

/** The words that wrote this expression, or the expression itself when no words would have. */
export function readPattern(regex: string): { mode: PatternMode; text: string } {
  if (regex === '') return { mode: 'contains', text: '' };

  for (const mode of READ_ORDER) {
    const text = textFor(mode, regex);
    if (text !== null) return { mode, text };
  }

  return { mode: 'regex', text: regex };
}

/**
 * The mode to draw.
 *
 * The reader's choice is held by the form, and the expression by the draft; this reconciles the
 * two without an effect. While the chosen mode still writes the expression — or there is no
 * expression yet, which every mode writes — the choice stands. When something else replaced the
 * expression, a template or a reload, the expression wins.
 */
export function modeOf(chosen: PatternMode, regex: string): PatternMode {
  if (regex === '' || chosen === 'regex') return chosen;

  return textFor(chosen, regex) !== null ? chosen : readPattern(regex).mode;
}

/** What the reader typed, in whatever mode the expression is drawn in. */
const typedIn = (mode: PatternMode, regex: string): string =>
  mode === 'regex' ? regex : (textFor(mode, regex) ?? '');

/** The expression after the mode select changes from `from` to `to`. */
export function switchMode(regex: string, from: PatternMode, to: PatternMode): string {
  if (to === 'regex') return regex;

  // Out of a hand-written expression, the words are whatever would have written it — and when
  // nothing would, the box starts empty rather than holding syntax that would now be escaped.
  const read = from === 'regex' ? readPattern(regex) : { mode: from, text: typedIn(from, regex) };
  if (read.mode === 'regex') return '';

  const text = to === 'anyWord' || read.mode !== 'anyWord' ? read.text : (wordsOf(read.text)[0] ?? '');

  return regexOf(to, text);
}
