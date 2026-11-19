# Alerts library groups and pattern builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the Alerts rule library by condition kind with a worked example of every setting, and replace the bare regex box with a builder that writes the regex from plain words and tries it on the topic's recent messages.

**Architecture:** Web only. Two pure modules (`patternBuilder.ts` writes and reads back regexes; `patternTry.ts` extracts the tested text the way the server does and judges it) under two components (`PatternFields.tsx` replaces the `pattern` case of `ConditionFields`; `PatternTry.tsx` is the tester). `templates.ts` becomes groups and `RuleLibrary.tsx` draws a section per group. The wire shape, the server and `ruleDraft.ts`'s conversions do not change — `regex` stays the only stored truth.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + Testing Library, CSS modules. Run everything from `web/`.

**Spec:** `docs/superpowers/specs/2026-11-19-alerts-library-groups-pattern-builder-design.md`

## Global Constraints

- No change to `src/` (.NET), `web/src/types/api.ts`, `alert-rules.json` or `ruleOf`/`draftOf`/`conditionOf`.
- UI text in English. Code comments say why, not what: careful prose, British spelling, wrapped at ~100 columns, matching the surrounding voice.
- Commits: one subject line, no body, conventional prefix then lower-case prose saying what now holds and why. Never push.
- Every example draft must have `faultsIn(draft, { topicPrefix: 'mqttforge/alerts/', allowWebhooks: true })` equal to `{}`.
- Test commands: `npx vitest run <path>` from `web/`. Type check: `npx tsc -b` from `web/`. Under load the full suite can time out at random (5 s); rerun a failing file alone before treating it as real.

---

## File map

| File | Responsibility |
|---|---|
| Create `web/src/features/alerts/patternBuilder.ts` | `PatternMode`, `regexOf`, `textFor`, `readPattern`, `modeOf`, `switchMode` |
| Create `web/src/features/alerts/patternBuilder.test.ts` | |
| Create `web/src/features/alerts/patternTry.ts` | `textAt`, `compilePattern`, `verdictOf`, `recentTexts` |
| Create `web/src/features/alerts/patternTry.test.ts` | |
| Create `web/src/features/alerts/PatternTry.tsx` + `PatternTry.module.css` | The tester |
| Create `web/src/features/alerts/PatternTry.test.tsx` | |
| Create `web/src/features/alerts/PatternFields.tsx` | The pattern form: mode, fire-when, text, saved regex, tester |
| Modify `web/src/features/alerts/ConditionFields.tsx` | `pattern` case delegates; optional `source` prop passed down |
| Modify `web/src/features/alerts/RuleEditor.tsx:243,592` | Pass `source={{ filter: draft.filter, field: draft.field }}` |
| Modify `web/src/features/alerts/ConditionFields.test.tsx`, `RuleEditor.test.tsx` | New labels |
| Rewrite `web/src/features/alerts/templates.ts` | `TEMPLATE_GROUPS` |
| Create `web/src/features/alerts/templates.test.ts` | |
| Modify `web/src/features/alerts/RuleLibrary.tsx` + `.module.css` + `.test.tsx` | Grouped layout |
| Modify `web/src/features/alerts/AlertsPanel.test.tsx:464` | New Use button name |

---

### Task 1: patternBuilder — write a regex from words, and read it back

**Files:**
- Create: `web/src/features/alerts/patternBuilder.ts`
- Test: `web/src/features/alerts/patternBuilder.test.ts`

**Interfaces:**
- Produces:
  - `type PatternMode = 'contains' | 'startsWith' | 'endsWith' | 'exactly' | 'anyWord' | 'regex'`
  - `type WordMode = Exclude<PatternMode, 'regex'>`
  - `PATTERN_MODES: ReadonlyArray<{ value: PatternMode; label: string }>`
  - `regexOf(mode: WordMode, text: string): string` — `''` for empty text
  - `textFor(mode: WordMode, regex: string): string | null` — the text that writes `regex` in that mode, or null
  - `readPattern(regex: string): { mode: PatternMode; text: string }`
  - `modeOf(chosen: PatternMode, regex: string): PatternMode` — the mode to draw: the chosen one while it still writes `regex`, else what `readPattern` says
  - `switchMode(regex: string, from: PatternMode, to: PatternMode): string` — the regex after the mode select changes

- [ ] **Step 1: Write the failing test**

```ts
// web/src/features/alerts/patternBuilder.test.ts
import { describe, expect, it } from 'vitest';
import { modeOf, readPattern, regexOf, switchMode, textFor, type WordMode } from './patternBuilder';

describe('writing a regex from words', () => {
  it.each([
    ['contains', 'ERROR', 'ERROR'],
    ['startsWith', 'ERR-', '^ERR-'],
    ['endsWith', 'timeout', 'timeout$'],
    ['exactly', 'OFFLINE', '^OFFLINE$'],
    ['anyWord', 'fault\noffline', '^(?:fault|offline)$'],
  ] as const)('%s %j writes %j', (mode, text, regex) => {
    expect(regexOf(mode, text)).toBe(regex);
  });

  it('escapes every character a regex would read as syntax', () => {
    expect(regexOf('contains', '\\^$.|?*+()[]{}')).toBe('\\\\\\^\\$\\.\\|\\?\\*\\+\\(\\)\\[\\]\\{\\}');
    expect(regexOf('startsWith', '2.')).toBe('^2\\.');
  });

  it('writes nothing for no text, whatever the mode', () => {
    for (const mode of ['contains', 'startsWith', 'endsWith', 'exactly', 'anyWord'] as const) {
      expect(regexOf(mode, '')).toBe('');
    }
    expect(regexOf('anyWord', '\n  \n')).toBe('');
  });

  it('trims the words of a list and drops the blank lines', () => {
    expect(regexOf('anyWord', ' fault \n\n offline\n')).toBe('^(?:fault|offline)$');
  });
});

describe('reading a regex back into words', () => {
  const modes: WordMode[] = ['contains', 'startsWith', 'endsWith', 'exactly', 'anyWord'];
  const texts = ['ERROR', 'a.b', '2.', 'x|y', 'fault\noffline', '$5 (net)'];

  it('reads back every regex the builder can write, as the mode and text that wrote it', () => {
    for (const mode of modes) {
      for (const text of texts) {
        const regex = regexOf(mode, text);
        if (mode !== 'anyWord' && text.includes('\n')) continue;

        const read = readPattern(regex);
        expect(regexOf(read.mode as WordMode, read.text)).toBe(regex);
      }
    }
    expect(readPattern('^OFFLINE$')).toEqual({ mode: 'exactly', text: 'OFFLINE' });
    expect(readPattern('^(?:fault|offline)$')).toEqual({ mode: 'anyWord', text: 'fault\noffline' });
    expect(readPattern('^2\\.')).toEqual({ mode: 'startsWith', text: '2.' });
  });

  it.each(['^ERR-[0-9]+', 'foo|bar', '^a$b', 'a\\d', 'x$y', '\\'])(
    'leaves %j, which no mode writes, as a regular expression',
    (regex) => {
      expect(readPattern(regex)).toEqual({ mode: 'regex', text: regex });
    },
  );

  it('reads an empty regex as contains with no text', () => {
    expect(readPattern('')).toEqual({ mode: 'contains', text: '' });
  });

  it('says which text writes a regex in a given mode, or that none does', () => {
    expect(textFor('contains', 'ERROR')).toBe('ERROR');
    expect(textFor('startsWith', 'ERROR')).toBeNull();
    expect(textFor('endsWith', 'a\\$')).toBeNull();
    expect(textFor('endsWith', 'a\\$$')).toBe('a$');
  });
});

describe('which mode is drawn', () => {
  it('keeps the chosen mode while it still writes the regex, and an empty one always', () => {
    expect(modeOf('startsWith', '')).toBe('startsWith');
    expect(modeOf('regex', '^OFF$')).toBe('regex');
    expect(modeOf('contains', 'OFF')).toBe('contains');
  });

  it('follows the regex when it was changed from outside, as a template or a reload does', () => {
    expect(modeOf('contains', '^OFF$')).toBe('exactly');
    expect(modeOf('startsWith', '[0-9]+')).toBe('regex');
  });
});

describe('changing the mode', () => {
  it('carries the text across the single-text modes', () => {
    expect(switchMode('ERROR', 'contains', 'startsWith')).toBe('^ERROR');
    expect(switchMode('^ERROR', 'startsWith', 'exactly')).toBe('^ERROR$');
  });

  it('takes one word into a list, and the first word of a list out of it', () => {
    expect(switchMode('^OFF$', 'exactly', 'anyWord')).toBe('^(?:OFF)$');
    expect(switchMode('^(?:fault|offline)$', 'anyWord', 'contains')).toBe('fault');
  });

  it('keeps the regex going into regular expression mode', () => {
    expect(switchMode('^ERR-', 'startsWith', 'regex')).toBe('^ERR-');
  });

  it('reads the words out of a regex leaving regular expression mode, or starts empty', () => {
    expect(switchMode('^ERR-', 'regex', 'endsWith')).toBe('ERR-$');
    expect(switchMode('^ERR-[0-9]+', 'regex', 'contains')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/alerts/patternBuilder.test.ts`
Expected: FAIL — `Failed to resolve import "./patternBuilder"`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/features/alerts/patternBuilder.ts

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/alerts/patternBuilder.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/alerts/patternBuilder.ts web/src/features/alerts/patternBuilder.test.ts
git commit -m "feat: a pattern can be written as contains, starts with, ends with, is exactly or any of these words, and a saved expression is read back into those words only when they would write it exactly, so opening a rule never changes it"
```

---

### Task 2: patternTry — the text a rule tests, and its verdict

**Files:**
- Create: `web/src/features/alerts/patternTry.ts`
- Test: `web/src/features/alerts/patternTry.test.ts`

**Interfaces:**
- Consumes: `parseBody`, `MAX_DEPTH`, `type Json` from `./payloadFields`; `type LogEntry` from `../../stores/logStore`.
- Produces:
  - `textAt(payload: string, field: string): string | null` — the body for `''`, else the field's text, null when missing
  - `type Compiled = { ok: true; regex: RegExp } | { ok: false; message: string }`
  - `compilePattern(regex: string): Compiled`
  - `type Verdict = 'fires' | 'quiet' | 'skipped'`
  - `verdictOf(regex: RegExp, negate: boolean, text: string | null): Verdict`
  - `type TriedText = { topic: string; text: string | null }`
  - `recentTexts(entries: readonly LogEntry[], field: string, limit?: number): TriedText[]` — entries newest first in, distinct `(topic, text)` out, at most `limit` (default 8)

- [ ] **Step 1: Write the failing test**

```ts
// web/src/features/alerts/patternTry.test.ts
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../stores/logStore';
import { compilePattern, recentTexts, textAt, verdictOf } from './patternTry';

describe('the text a rule tests', () => {
  it('is the body itself when the rule names no field', () => {
    expect(textAt('ERR-502 disk', '')).toBe('ERR-502 disk');
    expect(textAt('{"a":1}', '')).toBe('{"a":1}');
  });

  it('is a string field without its quotes, and any other value as JSON', () => {
    const body = '{"msg":"timeout","n":3,"ok":true,"none":null,"inner":{"x":[1,2]}}';

    expect(textAt(body, 'msg')).toBe('timeout');
    expect(textAt(body, 'n')).toBe('3');
    expect(textAt(body, 'ok')).toBe('true');
    expect(textAt(body, 'none')).toBe('null');
    expect(textAt(body, 'inner')).toBe('{"x":[1,2]}');
  });

  it('walks paths as the server does: dots, brackets, a leading $, and indexes on arrays', () => {
    const body = '{"a":{"b":[{"c":"deep"}]},"list":["zero","one"]}';

    expect(textAt(body, 'a.b[0].c')).toBe('deep');
    expect(textAt(body, '$.a.b[0].c')).toBe('deep');
    expect(textAt(body, 'list.1')).toBe('one');
    expect(textAt(body, 'list[1]')).toBe('one');
  });

  it('is missing when the field is not there, or there is no document to look in', () => {
    expect(textAt('{"a":1}', 'b')).toBeNull();
    expect(textAt('{"list":[1]}', 'list[5]')).toBeNull();
    expect(textAt('23.5', 'value')).toBeNull();
    expect(textAt('{broken', 'a')).toBeNull();
    expect(textAt('{"a":1}', 'a..b')).toBeNull();
  });

  it('stops at the depth the server stops at', () => {
    const body = '{"a":{"a":{"a":{"a":{"a":{"a":{"a":"seven"}}}}}}}';

    expect(textAt(body, 'a.a.a.a.a.a')).not.toBeNull();
    expect(textAt(body, 'a.a.a.a.a.a.a')).toBeNull();
  });
});

describe('the verdict', () => {
  const error = /ERROR/;

  it('is the rule’s answer, with negate applied', () => {
    expect(verdictOf(error, false, 'an ERROR here')).toBe('fires');
    expect(verdictOf(error, false, 'all fine')).toBe('quiet');
    expect(verdictOf(error, true, 'all fine')).toBe('fires');
    expect(verdictOf(error, true, 'an ERROR here')).toBe('quiet');
  });

  it('is a skip, never a match or a miss, when the field is missing', () => {
    expect(verdictOf(error, false, null)).toBe('skipped');
    expect(verdictOf(error, true, null)).toBe('skipped');
  });

  it('compiles an expression, or says why the browser cannot', () => {
    expect(compilePattern('^ERR').ok).toBe(true);

    const bad = compilePattern('([');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).not.toBe('');
  });
});

describe('the recent texts', () => {
  let id = 0;
  const entry = (topic: string, body: string, mode?: 'hex'): LogEntry => ({
    id: (id += 1),
    kind: 'recv',
    at: new Date(),
    topic,
    body,
    mode,
  });

  it('keeps each distinct text once, newest first, up to the limit', () => {
    const entries = [
      entry('d/1/log', 'c'),
      entry('d/1/log', 'b'),
      entry('d/1/log', 'c'),
      entry('d/2/log', 'c'),
      entry('d/1/log', 'a'),
    ];

    expect(recentTexts(entries, '', 3)).toEqual([
      { topic: 'd/1/log', text: 'c' },
      { topic: 'd/1/log', text: 'b' },
      { topic: 'd/2/log', text: 'c' },
    ]);
  });

  it('reads the field out of each, and leaves out binary bodies', () => {
    const entries = [entry('t', '{"msg":"x"}'), entry('t', '{"other":1}'), entry('t', '00 ff', 'hex')];

    expect(recentTexts(entries, 'msg')).toEqual([
      { topic: 't', text: 'x' },
      { topic: 't', text: null },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/alerts/patternTry.test.ts`
Expected: FAIL — `Failed to resolve import "./patternTry"`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/features/alerts/patternTry.ts
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

    if (found === null || typeof found !== 'object' || !Object.hasOwn(found, name)) return undefined;

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/alerts/patternTry.test.ts`
Expected: PASS. If `Object.hasOwn` fails the type check (`lib` older than ES2022), use `Object.prototype.hasOwnProperty.call(found, name)` instead.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/alerts/patternTry.ts web/src/features/alerts/patternTry.test.ts
git commit -m "feat: the console can say what a pattern rule would answer for a message, reading the field the way the server's payload walker does and skipping where the field is missing, so a tried rule and a running one agree"
```

---

### Task 3: PatternTry — the tester under the pattern form

**Files:**
- Create: `web/src/features/alerts/PatternTry.tsx`
- Create: `web/src/features/alerts/PatternTry.module.css`
- Test: `web/src/features/alerts/PatternTry.test.tsx`

**Interfaces:**
- Consumes: `compilePattern`, `verdictOf`, `recentTexts`, `type Verdict` from `./patternTry`; `runFor`, `useLogStore` from `../../stores/logStore`; `Field` from `../../components/Field`.
- Produces:
  - `type PatternSource = { filter: string; field: string }`
  - `PatternTry({ regex, negate, source }: { regex: string; negate: boolean; source: PatternSource })`
  - DOM: `section` labelled "Try the pattern"; rows `data-testid="try-row"` with `data-verdict`; own-text input labelled "Try your own text"; own verdict `data-testid="own-verdict"`; button "Refresh".

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/features/alerts/PatternTry.test.tsx
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useLogStore } from '../../stores/logStore';
import { PatternTry } from './PatternTry';

const message = (topic: string, payload: string): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: payload.length,
  qos: 0,
  retain: false,
  receivedAt: '2026-11-19T10:00:00Z',
});

const send = (...messages: DecodedMessage[]) =>
  act(() => useLogStore.getState().appendReceived(messages));

const verdicts = () =>
  screen.getAllByTestId('try-row').map((row) => row.getAttribute('data-verdict'));

beforeEach(() => useLogStore.getState().clear());

describe('trying a pattern', () => {
  it('judges the recent messages on the rule’s topics, newest first', () => {
    send(message('d/1/log', 'boot ok'), message('d/2/log', 'ERROR disk'));
    render(<PatternTry regex="ERROR" negate={false} source={{ filter: 'd/+/log', field: '' }} />);

    expect(verdicts()).toEqual(['fires', 'quiet']);
    // A wildcard filter covers several topics, so each row says which one it came from.
    expect(within(screen.getAllByTestId('try-row')[0]).getByText('d/2/log')).toBeInTheDocument();
  });

  it('gives the rule’s answer, so does-not-match flips it', () => {
    send(message('t', 'boot ok'));
    render(<PatternTry regex="ERROR" negate source={{ filter: 't', field: '' }} />);

    expect(verdicts()).toEqual(['fires']);
  });

  it('reads the rule’s field, and skips a message that does not carry it', () => {
    send(message('t', '{"msg":"timeout"}'), message('t', '{"other":1}'));
    render(<PatternTry regex="timeout" negate={false} source={{ filter: 't', field: 'msg' }} />);

    expect(verdicts()).toEqual(['skipped', 'fires']);
    expect(screen.getByText(/field missing/)).toBeInTheDocument();
  });

  it('tries the reader’s own text, with no messages at all', async () => {
    render(<PatternTry regex="^ERR-" negate={false} source={{ filter: 'nothing/here', field: '' }} />);

    expect(screen.getByText(/No messages on this topic yet/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Try your own text'), 'ERR-7');
    expect(screen.getByTestId('own-verdict')).toHaveTextContent('fires');

    await userEvent.clear(screen.getByLabelText('Try your own text'));
    await userEvent.type(screen.getByLabelText('Try your own text'), 'ok');
    expect(screen.getByTestId('own-verdict')).toHaveTextContent('no');
  });

  it('says why an expression cannot be tried, in place of the verdicts', () => {
    send(message('t', 'x'));
    render(<PatternTry regex="([" negate={false} source={{ filter: 't', field: '' }} />);

    expect(screen.getByText(/Not a valid expression/)).toBeInTheDocument();
    expect(screen.queryByTestId('try-row')).not.toBeInTheDocument();
  });

  it('holds its rows still while traffic arrives, until Refresh', async () => {
    send(message('t', 'first'));
    render(<PatternTry regex="x" negate={false} source={{ filter: 't', field: '' }} />);

    send(message('t', 'second'));
    expect(screen.getAllByTestId('try-row')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getAllByTestId('try-row')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/alerts/PatternTry.test.tsx`
Expected: FAIL — `Failed to resolve import "./PatternTry"`.

- [ ] **Step 3: Write the implementation**

```tsx
// web/src/features/alerts/PatternTry.tsx
import { useId, useState } from 'react';
import { Field } from '../../components/Field';
import panel from '../../styles/panel.module.css';
import { runFor, useLogStore, type LogEntry } from '../../stores/logStore';
import { compilePattern, recentTexts, verdictOf, type Verdict } from './patternTry';
import styles from './PatternTry.module.css';

/** The rule's topic filter and field, which decide what a pattern is tried against. */
export type PatternSource = { filter: string; field: string };

const WORDS: Record<Verdict, string> = {
  fires: 'fires',
  quiet: 'no',
  skipped: 'skipped — field missing',
};

const read = (filter: string): LogEntry[] =>
  filter.trim() === '' ? [] : runFor(useLogStore.getState().byTopic, filter.trim());

/**
 * A pattern, tried on what the rule's topics have already said and on whatever the reader types.
 *
 * The messages are read once, and again on Refresh, rather than followed: a busy topic would
 * otherwise move every row under the reader's eye between one keystroke and the next, and the
 * question being asked — does this expression say what I mean — is about the expression, not
 * about what arrived in the last second.
 */
export function PatternTry({
  regex,
  negate,
  source,
}: {
  regex: string;
  negate: boolean;
  source: PatternSource;
}) {
  const [entries, setEntries] = useState(() => read(source.filter));
  const [own, setOwn] = useState('');
  const ownId = useId();

  const compiled = compilePattern(regex);
  const rows = recentTexts(entries, source.field);
  const wild = /[+#]/.test(source.filter);
  // An empty expression matches everything and judges nothing; the form already says it is needed.
  const judge = (text: string | null): Verdict | null =>
    compiled.ok && regex !== '' ? verdictOf(compiled.regex, negate, text) : null;
  const ownVerdict = own === '' ? null : judge(own);

  return (
    <section aria-label="Try the pattern" className={styles.try}>
      <div className={styles.head}>
        <span className={styles.title}>Try it</span>
        <button type="button" onClick={() => setEntries(read(source.filter))}>
          Refresh
        </button>
      </div>

      {!compiled.ok ? (
        <p className={panel.fault}>Not a valid expression: {compiled.message}</p>
      ) : rows.length === 0 ? (
        <p className={panel.note}>No messages on this topic yet — type one below.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => {
            const verdict = judge(row.text);

            return (
              <li
                key={`${row.topic}\u0000${row.text ?? ''}`}
                className={styles.row}
                data-testid="try-row"
                data-verdict={verdict ?? ''}
              >
                {wild && <span className={styles.topic}>{row.topic}</span>}
                <span className={styles.text}>{row.text ?? '—'}</span>
                <span className={styles.verdict} data-verdict={verdict ?? ''}>
                  {verdict ? WORDS[verdict] : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Field label="Try your own text" htmlFor={ownId}>
        <div className={styles.own}>
          <input
            id={ownId}
            value={own}
            spellCheck={false}
            onChange={(event) => setOwn(event.target.value)}
          />
          <span className={styles.verdict} data-testid="own-verdict" data-verdict={ownVerdict ?? ''}>
            {ownVerdict ? WORDS[ownVerdict] : ''}
          </span>
        </div>
      </Field>
    </section>
  );
}
```

```css
/* web/src/features/alerts/PatternTry.module.css */

/* Set apart from the fields above it: this is a question asked of them, not another of them. */
.try {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--paper);
  border-radius: var(--r-control);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.title {
  font-family: var(--mono);
  font-size: var(--t-micro);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Topic, text and verdict on one line; the text gives way, the verdict never does. */
.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-family: var(--mono);
  font-size: var(--t-micro);
}
.topic { flex: 0 1 auto; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.text { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }

.verdict { flex: 0 0 auto; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); }
.verdict[data-verdict='fires'] { color: var(--warn); font-weight: 600; }

.own { display: flex; align-items: center; gap: 8px; }
.own input { flex: 1 1 auto; min-width: 0; }
```

`--warn`, `--muted`, `--ink`, `--paper`, `--mono` and `--t-micro` are existing tokens in `web/src/styles/tokens.css`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/alerts/PatternTry.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/alerts/PatternTry.tsx web/src/features/alerts/PatternTry.module.css web/src/features/alerts/PatternTry.test.tsx
git commit -m "feat: a pattern can be tried on the rule's recent messages and on typed text, each row giving the rule's own answer, and the rows hold still until Refresh so a busy topic does not move them while the expression is being written"
```

---

### Task 4: PatternFields — the builder in the rule editor

**Files:**
- Create: `web/src/features/alerts/PatternFields.tsx`
- Modify: `web/src/features/alerts/ConditionFields.tsx` (Props, `pattern` case lines 194-217, composite recursion at 448)
- Modify: `web/src/features/alerts/RuleEditor.tsx:243-247, 592-596`
- Test: `web/src/features/alerts/ConditionFields.test.tsx`, `web/src/features/alerts/RuleEditor.test.tsx:190,198`

**Interfaces:**
- Consumes: Task 1 (`PATTERN_MODES`, `modeOf`, `switchMode`, `regexOf`, `textFor`, `type PatternMode`), Task 3 (`PatternTry`, `type PatternSource`).
- Produces: `PatternFields({ condition, onChange, id, source })` where `condition: Extract<DraftCondition, { type: 'pattern' }>`; `ConditionFields` gains optional `source?: PatternSource`.
- Labels: "How it matches" (select), "Fire when" (select, values `match` / `miss`), "Text" (contains/starts/ends/exactly), "One word to a line" (anyWord), "Expression" (regex). Saved regex note `data-testid="pattern-regex"`.

- [ ] **Step 1: Write the failing tests**

In `ConditionFields.test.tsx`, add `'Text'` and `'One word to a line'` to `EVERY_FIELD`, and replace the `'draws a pattern as an expression'` test with:

```tsx
  it('draws a pattern as words, with the expression they write shown under them', () => {
    draw(blankCondition('pattern'));
    only('Text');
    expect(screen.getByLabelText('How it matches')).toHaveValue('contains');
    expect(screen.getByLabelText('Fire when')).toHaveValue('match');
  });
```

and add a new `describe` at the end of the file:

```tsx
describe('the pattern builder', () => {
  /** A controlled form, so typed text goes round through the draft as the editor's does. */
  function Held({ start }: { start: DraftCondition }) {
    const [condition, setCondition] = useState(start);
    return (
      <>
        <ConditionFields condition={condition} onChange={setCondition} id={(name) => `x-${name}`} />
        <output data-testid="held">{JSON.stringify(condition)}</output>
      </>
    );
  }
  const held = () => JSON.parse(screen.getByTestId('held').textContent!) as DraftCondition;

  it('writes the expression from the words and the mode', async () => {
    render(<Held start={blankCondition('pattern')} />);

    await userEvent.selectOptions(screen.getByLabelText('How it matches'), 'startsWith');
    await userEvent.type(screen.getByLabelText('Text'), 'ERR-2.');

    expect(held()).toEqual({ type: 'pattern', regex: '^ERR-2\\.', negate: false });
    expect(screen.getByTestId('pattern-regex')).toHaveTextContent('^ERR-2\\.');
  });

  it('takes a list one word to a line', async () => {
    render(<Held start={blankCondition('pattern')} />);

    await userEvent.selectOptions(screen.getByLabelText('How it matches'), 'anyWord');
    await userEvent.type(screen.getByLabelText('One word to a line'), 'fault{enter}offline');

    expect(held()).toMatchObject({ regex: '^(?:fault|offline)$' });
  });

  it('turns does-not-match on from the Fire when select', async () => {
    render(<Held start={{ type: 'pattern', regex: 'ERROR', negate: false }} />);

    await userEvent.selectOptions(screen.getByLabelText('Fire when'), 'miss');

    expect(held()).toMatchObject({ regex: 'ERROR', negate: true });
  });

  it('opens a hand-written expression as it is, and saves it untouched', () => {
    render(<Held start={{ type: 'pattern', regex: '^ERR-[0-9]+', negate: false }} />);

    expect(screen.getByLabelText('How it matches')).toHaveValue('regex');
    expect(screen.getByLabelText('Expression')).toHaveValue('^ERR-[0-9]+');
    expect(held()).toMatchObject({ regex: '^ERR-[0-9]+' });
  });

  it('opens an expression the words would write in those words', () => {
    render(<Held start={{ type: 'pattern', regex: '^OFFLINE$', negate: false }} />);

    expect(screen.getByLabelText('How it matches')).toHaveValue('exactly');
    expect(screen.getByLabelText('Text')).toHaveValue('OFFLINE');
  });

  it('keeps the text when the mode changes', async () => {
    render(<Held start={{ type: 'pattern', regex: 'timeout', negate: false }} />);

    await userEvent.selectOptions(screen.getByLabelText('How it matches'), 'endsWith');

    expect(screen.getByLabelText('Text')).toHaveValue('timeout');
    expect(held()).toMatchObject({ regex: 'timeout$' });
  });

  it('holds an empty mode the reader chose, before anything is typed', async () => {
    render(<Held start={blankCondition('pattern')} />);

    await userEvent.selectOptions(screen.getByLabelText('How it matches'), 'exactly');

    expect(screen.getByLabelText('How it matches')).toHaveValue('exactly');
    expect(held()).toMatchObject({ regex: '' });
  });
});
```

Add `import { useState } from 'react';` to the test file's imports.

In `RuleEditor.test.tsx`, the tree fixture holds `{ type: 'pattern', regex: '^OFF$' }`, which now opens as Is exactly. Change both assertions at lines 190 and 198 from

```tsx
expect(screen.getByLabelText('Expression')).toHaveValue('^OFF$');
```

to

```tsx
expect(screen.getByLabelText('Text')).toHaveValue('OFF');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/alerts/ConditionFields.test.tsx src/features/alerts/RuleEditor.test.tsx`
Expected: FAIL — no element labelled "Text" / "How it matches".

- [ ] **Step 3: Write PatternFields**

```tsx
// web/src/features/alerts/PatternFields.tsx
import { useState } from 'react';
import { Field } from '../../components/Field';
import panel from '../../styles/panel.module.css';
import {
  modeOf,
  PATTERN_MODES,
  readPattern,
  regexOf,
  switchMode,
  textFor,
  type PatternMode,
} from './patternBuilder';
import { PatternTry, type PatternSource } from './PatternTry';
import type { DraftCondition } from './ruleDraft';

type Pattern = Extract<DraftCondition, { type: 'pattern' }>;

/**
 * A pattern written in words, with the expression they make shown under them and tried below.
 *
 * The draft holds the expression and nothing else, as the rule file does; the mode is this form's
 * own, and `modeOf` reconciles the two on every render. That is what lets a template or a reload
 * replace the expression without an effect chasing it: the form draws whatever the expression
 * now says.
 */
export function PatternFields({
  condition,
  onChange,
  id,
  source,
}: {
  condition: Pattern;
  onChange: (condition: DraftCondition) => void;
  id: (name: string) => string;
  source: PatternSource;
}) {
  const [chosen, setChosen] = useState<PatternMode>(() => readPattern(condition.regex).mode);
  const mode = modeOf(chosen, condition.regex);
  const text = mode === 'regex' ? condition.regex : (textFor(mode, condition.regex) ?? '');

  const write = (typed: string) =>
    onChange({ ...condition, regex: mode === 'regex' ? typed : regexOf(mode, typed) });

  return (
    <>
      <div className={panel.row}>
        <Field label="How it matches" htmlFor={id('mode')}>
          <select
            id={id('mode')}
            value={mode}
            onChange={(event) => {
              const next = event.target.value as PatternMode;

              setChosen(next);
              onChange({ ...condition, regex: switchMode(condition.regex, mode, next) });
            }}
          >
            {PATTERN_MODES.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fire when" htmlFor={id('negate')}>
          <select
            id={id('negate')}
            value={condition.negate ? 'miss' : 'match'}
            onChange={(event) => onChange({ ...condition, negate: event.target.value === 'miss' })}
          >
            <option value="match">it matches</option>
            <option value="miss">it does not match</option>
          </select>
        </Field>
      </div>

      {mode === 'regex' ? (
        <Field label="Expression" htmlFor={id('regex')}>
          <input
            id={id('regex')}
            value={text}
            spellCheck={false}
            placeholder="^ERR-[0-9]+"
            onChange={(event) => write(event.target.value)}
          />
        </Field>
      ) : mode === 'anyWord' ? (
        <AnyWord id={id('words')} regex={condition.regex} onWrite={write} />
      ) : (
        <Field label="Text" htmlFor={id('text')}>
          <input
            id={id('text')}
            value={text}
            spellCheck={false}
            onChange={(event) => write(event.target.value)}
          />
        </Field>
      )}

      {/* The expression the words make, so a reader learns the syntax by watching it written —
          and can switch to Regular expression to take it further from there. */}
      {mode !== 'regex' && condition.regex !== '' && (
        <p className={panel.note} data-testid="pattern-regex">
          Saved as <code>{condition.regex}</code>
        </p>
      )}

      <PatternTry regex={condition.regex} negate={condition.negate} source={source} />
    </>
  );
}

/**
 * The list box, which holds its own text.
 *
 * The one box whose typing cannot round-trip through the expression: a newline just pressed, or
 * a blank line between two words, writes the same expression as no newline at all, and a box
 * drawn back from the expression would swallow the keystroke. So it keeps what was typed and
 * only takes the expression's word when that no longer agrees with it.
 */
function AnyWord({
  id,
  regex,
  onWrite,
}: {
  id: string;
  regex: string;
  onWrite: (typed: string) => void;
}) {
  const [typed, setTyped] = useState(() => textFor('anyWord', regex) ?? '');
  const shown = regexOf('anyWord', typed) === regex ? typed : (textFor('anyWord', regex) ?? '');

  return (
    <Field label="One word to a line" htmlFor={id}>
      <textarea
        id={id}
        rows={4}
        value={shown}
        spellCheck={false}
        onChange={(event) => {
          setTyped(event.target.value);
          onWrite(event.target.value);
        }}
      />
    </Field>
  );
}
```

The same round-trip problem exists, more mildly, for the single-text box: typing a trailing space writes `ERR ` and reads back as `ERR ` — that is fine, since escaping keeps spaces. No local state needed there.

- [ ] **Step 4: Wire it into ConditionFields and RuleEditor**

In `ConditionFields.tsx`:

```tsx
// imports
import { PatternFields } from './PatternFields';
import type { PatternSource } from './PatternTry';

type Props = {
  condition: DraftCondition;
  onChange: (condition: DraftCondition) => void;
  /** The window's own id maker, so two editors open at once do not share a field. */
  id: (name: string) => string;
  /** The rule's topic filter and field, which a pattern is tried against. Absent tries nothing. */
  source?: PatternSource;
};

const NOWHERE: PatternSource = { filter: '', field: '' };

export function ConditionFields({ condition, onChange, id, source = NOWHERE }: Props) {
```

Replace the whole `case 'pattern':` block with:

```tsx
    case 'pattern':
      return <PatternFields condition={condition} onChange={onChange} id={id} source={source} />;
```

In the composite branch, pass `source={source}` to the nested `<ConditionFields ... />`.

In `RuleEditor.tsx`, add to both `<ConditionFields>` calls (lines 243 and 592):

```tsx
        source={{ filter: draft.filter, field: draft.field }}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/alerts/`
Expected: PASS. `RuleLibrary.test.tsx` and `AlertsPanel.test.tsx` are untouched by this task and must still pass.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/alerts/PatternFields.tsx web/src/features/alerts/ConditionFields.tsx web/src/features/alerts/RuleEditor.tsx web/src/features/alerts/ConditionFields.test.tsx web/src/features/alerts/RuleEditor.test.tsx
git commit -m "feat: the pattern form asks how it matches and what to look for, shows the expression that makes and tries it on the rule's own topics, so a pattern rule no longer starts from regex syntax and is no longer saved on a guess"
```

---

### Task 5: Templates as groups, with an example of every setting

**Files:**
- Rewrite: `web/src/features/alerts/templates.ts`
- Create: `web/src/features/alerts/templates.test.ts`

**Interfaces:**
- Consumes: `draftOf`, `faultsIn`, `CONDITION_TYPES`, `type ConditionType`, `type DraftCondition`, `type DraftRule` from `./ruleDraft`.
- Produces:
  - `type RuleExample = { title: string; story: string; draft: () => DraftRule }`
  - `type TemplateGroup = { type: ConditionType; says: string; examples: readonly RuleExample[] }`
  - `TEMPLATE_GROUPS: readonly TemplateGroup[]`
  - `TEMPLATES` is removed.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/features/alerts/templates.test.ts
import { describe, expect, it } from 'vitest';
import { CONDITION_TYPES, faultsIn } from './ruleDraft';
import { TEMPLATE_GROUPS } from './templates';

const WHERE = { topicPrefix: 'mqttforge/alerts/', allowWebhooks: true };
const EVERY = TEMPLATE_GROUPS.flatMap((group) =>
  group.examples.map((example) => [group.type, example.title, group, example] as const),
);

describe('the rule templates', () => {
  it('has one group for every kind of condition, in the editor’s order', () => {
    expect(TEMPLATE_GROUPS.map((group) => group.type)).toEqual([...CONDITION_TYPES]);
  });

  it('gives every group more than one example, each with a title nobody else uses', () => {
    for (const group of TEMPLATE_GROUPS) expect(group.examples.length).toBeGreaterThan(1);

    const titles = EVERY.map(([, title]) => title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it.each(EVERY)('%s: %s is a rule of its own kind', (type, _title, _group, example) => {
    expect(example.draft().condition.type).toBe(type);
  });

  // An example that cannot be saved as it stands is not an example.
  it.each(EVERY)('%s: %s would save as it is', (_type, _title, _group, example) => {
    expect(faultsIn(example.draft(), WHERE)).toEqual({});
  });

  it('gives a fresh copy each time, so two rules from one example share nothing', () => {
    const [first] = TEMPLATE_GROUPS[0].examples;

    expect(first.draft()).not.toBe(first.draft());
    expect(first.draft().condition).not.toBe(first.draft().condition);
  });

  it('covers every operator, method and metric the forms offer', () => {
    const conditions = EVERY.flatMap(([, , , example]) => {
      const { condition } = example.draft();
      return condition.type === 'all' || condition.type === 'any' ? condition.of : [condition];
    });
    const seen = (pick: (c: (typeof conditions)[number]) => string | undefined) =>
      new Set(conditions.map(pick).filter(Boolean));

    expect(seen((c) => (c.type === 'threshold' ? c.op : undefined))).toEqual(
      new Set(['gt', 'lt', 'eq', 'neq']),
    );
    expect(seen((c) => (c.type === 'band' ? String(c.inside) : undefined))).toEqual(
      new Set(['true', 'false']),
    );
    expect(seen((c) => (c.type === 'outlier' ? c.method : undefined))).toEqual(
      new Set(['sigma', 'tukey']),
    );
    expect(seen((c) => (c.type === 'pulse' ? c.metric : undefined))).toEqual(
      new Set(['count', 'duty', 'period', 'width']),
    );
    expect(seen((c) => (c.type === 'pattern' || c.type === 'oneOf' ? String(c.negate) : undefined))).toEqual(
      new Set(['true', 'false']),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/alerts/templates.test.ts`
Expected: FAIL — `TEMPLATE_GROUPS` is not exported.

- [ ] **Step 3: Rewrite templates.ts**

```ts
// web/src/features/alerts/templates.ts
import { draftOf, type ConditionType, type DraftCondition, type DraftRule } from './ruleDraft';

/**
 * A worked example of every setting of every kind of condition the engine knows.
 *
 * Grouped by kind, because one example a kind taught what a kind is and not what it can do: a
 * reader who saw `threshold < 13` never learnt that the same condition reads a JSON field, waits
 * out a For, or asks ≠. Each example is a whole rule, not a condition — 'this topic, this test,
 * this loud' teaches more than a box labelled Threshold — and every field of it stays editable:
 * Use opens the ordinary editor on a copy.
 *
 * `says` is the kind in one line, under its heading. `story` is the example as something that
 * happens in a building, behind the mark on its card. Two sentences at most: the card does not
 * grow to hold it.
 */
export type RuleExample = {
  /** The scenario's name on its card. Unique across the library, since it names the card. */
  title: string;
  story: string;
  /** A fresh draft every time, so two rules started from one example share nothing. */
  draft: () => DraftRule;
};

export type TemplateGroup = {
  type: ConditionType;
  says: string;
  examples: readonly RuleExample[];
};

const made = (
  name: string,
  filter: string,
  condition: DraftCondition,
  rest: Partial<DraftRule> = {},
): (() => DraftRule) => () => ({
  ...draftOf(undefined, undefined),
  name,
  filter,
  condition: structuredClone(condition),
  ...structuredClone(rest),
});

/** In the order the editor's own list offers the kinds. */
export const TEMPLATE_GROUPS: readonly TemplateGroup[] = [
  {
    type: 'threshold',
    says: 'Value crosses a limit.',
    examples: [
      {
        title: 'Upper limit',
        story: 'The server rack should stay below 35 °C. A failed fan pushes it over, and you hear about it.',
        draft: made('Rack too hot', 'sensors/rack/temp', { type: 'threshold', op: 'gt', value: '35' }),
      },
      {
        title: 'Lower limit',
        story: 'Water pipes run through the garage. If it drops below 13 °C overnight, you are warned before they freeze.',
        draft: made('Garage low temperature', 'sensors/garage/temp', { type: 'threshold', op: 'lt', value: '13' }),
      },
      {
        title: 'Equals',
        story: 'The pump reports 1 while it runs and 0 when it stops. A 0 is worth knowing about.',
        draft: made('Pump stopped', 'devices/pump/state', { type: 'threshold', op: 'eq', value: '0' }),
      },
      {
        title: 'Not equal',
        story: 'The heating should always be in mode 1, automatic. Anyone switching it to anything else is noticed.',
        draft: made('Heating not on automatic', 'devices/hvac/mode', { type: 'threshold', op: 'neq', value: '1' }),
      },
      {
        title: 'Battery from a JSON field',
        story: 'Every device sends {"battery": 87, ...}. The rule reads only the battery field and warns below 20%.',
        draft: made(
          'Device battery low',
          'devices/+/status',
          { type: 'threshold', op: 'lt', value: '20' },
          { field: 'battery' },
        ),
      },
      {
        title: 'Only if it lasts',
        story: 'A CPU spikes to 100% for a moment all the time. Above 90% for two whole minutes is a real problem.',
        draft: made(
          'CPU busy for two minutes',
          'servers/+/cpu',
          { type: 'threshold', op: 'gt', value: '90' },
          { for: '120' },
        ),
      },
    ],
  },
  {
    type: 'band',
    says: 'Value leaves or enters a range.',
    examples: [
      {
        title: 'Leaves its range',
        story: 'A 4-20 mA line reads below 4 when the wire breaks and above 20 when it shorts. Either alerts.',
        draft: made(
          '4-20 mA line fault',
          'sensors/line/current',
          { type: 'band', low: '4', high: '20', inside: false },
          { severity: 'critical' },
        ),
      },
      {
        title: 'Enters a range',
        story: 'Mould grows when the cellar stays between 70% and 100% humidity. Entering that zone alerts.',
        draft: made('Cellar in the mould zone', 'sensors/cellar/humidity', {
          type: 'band',
          low: '70',
          high: '100',
          inside: true,
        }),
      },
      {
        title: 'Clears with a margin',
        story: 'The boiler is safe between 1 and 2.5 bar. The alert clears only once it is back between 1.2 and 2.3, so a reading hovering at the edge does not flap.',
        draft: made(
          'Boiler pressure, with a margin',
          'sensors/boiler/pressure',
          { type: 'band', low: '1', high: '2.5', inside: false },
          { clear: { type: 'band', low: '1.2', high: '2.3', inside: true } },
        ),
      },
    ],
  },
  {
    type: 'pattern',
    says: 'Text matches what you describe.',
    examples: [
      {
        title: 'Contains',
        story: 'A device writes log lines. Any line with ERROR in it, anywhere, raises an alert.',
        draft: made('Error in a device log', 'devices/+/log', { type: 'pattern', regex: 'ERROR', negate: false }),
      },
      {
        title: 'Starts with',
        story: 'Error lines begin with a code such as ERR-502. Lines that merely mention one later are ignored.',
        draft: made('Device error code', 'devices/+/log', { type: 'pattern', regex: '^ERR-', negate: false }),
      },
      {
        title: 'Ends with',
        story: 'The gateway reports events like "upload timeout". Anything ending in timeout alerts.',
        draft: made('Gateway timeout', 'gateway/+/event', { type: 'pattern', regex: 'timeout$', negate: false }),
      },
      {
        title: 'Is exactly',
        story: 'A device says OFFLINE, and only that, when it drops off. "OFFLINE soon" is not the same thing.',
        draft: made('Device offline', 'devices/+/status', { type: 'pattern', regex: '^OFFLINE$', negate: false }),
      },
      {
        title: 'Does not match',
        story: 'Every device should be on firmware 2.x. One that reports anything not starting with 2. is out of date.',
        draft: made(
          'Old firmware',
          'devices/+/firmware',
          { type: 'pattern', regex: '^2\\.', negate: true },
          { severity: 'info' },
        ),
      },
      {
        title: 'Regular expression on a field',
        story: 'Events arrive as {"msg": "..."}. A message reporting a timeout or a refused connection alerts.',
        draft: made(
          'Connection trouble',
          'devices/+/event',
          { type: 'pattern', regex: 'timeout|refused', negate: false },
          { field: 'msg' },
        ),
      },
    ],
  },
  {
    type: 'oneOf',
    says: 'Value is one of a fixed set.',
    examples: [
      {
        title: 'Deny-list',
        story: 'A lamp reports its state. "on" and "off" are normal; "fault" or "offline" raises an alert.',
        draft: made(
          'Lamp fault state',
          'devices/lamp/+/state',
          { type: 'oneOf', values: 'fault\noffline', negate: false },
          { severity: 'critical' },
        ),
      },
      {
        title: 'Allow-list',
        story: 'A door is open or closed. Anything else — "jammed", an empty message, a typo — is unexpected.',
        draft: made('Door in an unknown state', 'devices/door/+/state', {
          type: 'oneOf',
          values: 'open\nclosed',
          negate: true,
        }),
      },
      {
        title: 'Status from a JSON field',
        story: 'Devices send {"status": "ok", ...}. The rule reads the status field alone and alerts on error or fault.',
        draft: made(
          'Device reports an error',
          'devices/+/status',
          { type: 'oneOf', values: 'error\nfault', negate: false },
          { field: 'status' },
        ),
      },
    ],
  },
  {
    type: 'silence',
    says: 'No message for a set time.',
    examples: [
      {
        title: 'Battery died',
        story: 'The loft sensor reports every minute. Its battery dies and nothing arrives. After 15 minutes you are told.',
        draft: made('Loft sensor silent', 'sensors/loft/temp', { type: 'silence', after: '900' }, { severity: 'info' }),
      },
      {
        title: 'Heartbeat',
        story: 'The PLC sends a heartbeat every 5 seconds. Thirty seconds without one means it has stopped.',
        draft: made(
          'PLC heartbeat lost',
          'plc/main/heartbeat',
          { type: 'silence', after: '30' },
          { severity: 'critical' },
        ),
      },
      {
        title: 'Every device on its own',
        story: 'One rule watches every device’s heartbeat. Each one that goes quiet for two minutes alerts by name.',
        draft: made('Device heartbeat lost', 'devices/+/heartbeat', { type: 'silence', after: '120' }),
      },
    ],
  },
  {
    type: 'outlier',
    says: 'A reading far from recent values.',
    examples: [
      {
        title: 'Sigma fence',
        story: 'The energy meter climbs steadily. One reading jumps far above the rest: a glitch or a short circuit.',
        draft: made('Energy meter outlier', 'home/energy/meter', {
          type: 'outlier',
          method: 'sigma',
          k: '3',
          window: '',
        }),
      },
      {
        title: 'Tukey fence',
        story: 'Water flow is mostly low with the odd long run, so it is lopsided. Tukey’s fence copes with that where sigma would cry wolf.',
        draft: made('Flow rate outlier', 'sensors/flow/rate', {
          type: 'outlier',
          method: 'tukey',
          k: '1.5',
          window: '',
        }),
      },
      {
        title: 'Short memory',
        story: 'Vibration changes with the load through the day. Judging each reading against only the last 50 follows that.',
        draft: made('Vibration spike', 'sensors/vibration/rms', {
          type: 'outlier',
          method: 'sigma',
          k: '3',
          window: '50',
        }),
      },
    ],
  },
  {
    type: 'distributionShift',
    says: 'Recent values settle at a different level.',
    examples: [
      {
        title: 'Level moved',
        story: 'Kitchen humidity sat around 55% last week and now sits around 65%. No single reading is alarming, but the level has moved.',
        draft: made('Kitchen humidity drift', 'sensors/kitchen/humidity', {
          type: 'distributionShift',
          window: '200',
        }),
      },
      {
        title: 'Slow drift',
        story: 'A level sensor creeps as it loses calibration. Over a thousand readings the creep shows where a short sample would not.',
        draft: made('Tank level calibration drift', 'sensors/tank/level', {
          type: 'distributionShift',
          window: '1000',
        }),
      },
    ],
  },
  {
    type: 'shapeChange',
    says: 'A value changes character.',
    examples: [
      {
        title: 'Quantity became a switch',
        story: 'A fan’s speed normally varies smoothly. After a controller fault it only jumps between stopped and full.',
        draft: made('Fan speed shape', 'devices/fan/speed', { type: 'shapeChange', window: '200' }),
      },
      {
        title: 'Sensor stuck',
        story: 'A door contact flips between open and closed all day. When it sends one value for ever, the sensor is stuck.',
        draft: made('Door contact stuck', 'sensors/door/contact', { type: 'shapeChange', window: '200' }),
      },
    ],
  },
  {
    type: 'pulse',
    says: 'Counts or times the pulses in a signal.',
    examples: [
      {
        title: 'Pulse count',
        story: 'The front door normally opens once or twice an hour. More than five openings in the sample is unusual.',
        draft: made('Front door activity', 'alerts/door/front', {
          type: 'pulse',
          metric: 'count',
          op: 'gt',
          value: '5',
          window: '',
        }),
      },
      {
        title: 'Pulse share',
        story: 'The pump is off most of the time. Running in more than 3 readings of every 10 means something is drawing water.',
        draft: made('Pump running too much', 'devices/pump/run', {
          type: 'pulse',
          metric: 'duty',
          op: 'gt',
          value: '0.3',
          window: '',
        }),
      },
      {
        title: 'Pulse interval',
        story: 'The beacon blinks every second. Blinks more than two seconds apart mean it is failing.',
        draft: made('Beacon blinking slowly', 'devices/beacon/led', {
          type: 'pulse',
          metric: 'period',
          op: 'gt',
          value: '2000',
          window: '',
        }),
      },
      {
        title: 'Pulse duration',
        story: 'The valve opens for a second or two at a time. Open for longer than five seconds, it is sticking.',
        draft: made('Valve sticking open', 'devices/valve/open', {
          type: 'pulse',
          metric: 'width',
          op: 'gt',
          value: '5000',
          window: '',
        }),
      },
    ],
  },
  {
    type: 'all',
    says: 'Every listed condition is true.',
    examples: [
      {
        title: 'Cold and abnormal',
        story: 'A cold night alone is normal. Alert only when the garage is cold and the reading is also abnormal.',
        draft: made('Garage cold and abnormal', 'sensors/garage/temp', {
          type: 'all',
          of: [
            { type: 'threshold', op: 'lt', value: '13' },
            { type: 'outlier', method: 'sigma', k: '3', window: '' },
          ],
        }),
      },
      {
        title: 'Out of range and chattering',
        story: 'A line that leaves its range once is a blip. Out of range and flicking in and out more than ten times is a loose wire.',
        draft: made('Loose wire on the line', 'sensors/line/current', {
          type: 'all',
          of: [
            { type: 'band', low: '4', high: '20', inside: false },
            { type: 'pulse', metric: 'count', op: 'gt', value: '10', window: '' },
          ],
        }),
      },
    ],
  },
  {
    type: 'any',
    says: 'At least one listed condition is true.',
    examples: [
      {
        title: 'Cold or silent',
        story: 'The garage is near freezing, or its sensor has stopped reporting. Either one is a problem.',
        draft: made('Garage cold or silent', 'sensors/garage/temp', {
          type: 'any',
          of: [
            { type: 'threshold', op: 'lt', value: '5' },
            { type: 'silence', after: '600' },
          ],
        }),
      },
      {
        title: 'Error text or fault state',
        story: 'A device may say ERROR in a sentence, or report the single word fault. Either is worth hearing about.',
        draft: made('Device in trouble', 'devices/+/status', {
          type: 'any',
          of: [
            { type: 'pattern', regex: 'ERROR', negate: false },
            { type: 'oneOf', values: 'fault', negate: false },
          ],
        }),
      },
    ],
  },
];
```

The threshold group covers `gt`, `lt`, `eq`, `neq`; `gte` and `lte` are the same examples with the edge included and get no card of their own — the test pins exactly the four.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/alerts/templates.test.ts`
Expected: PASS. `RuleLibrary.test.tsx` now fails to compile against `TEMPLATES` — that is Task 6.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/alerts/templates.ts web/src/features/alerts/templates.test.ts
git commit -m "feat: the rule templates are grouped by kind with an example of every operator, method, metric, field and negation, each one a rule that would save as it stands"
```

---

### Task 6: RuleLibrary — a section per kind, with chips to jump between them

**Files:**
- Modify: `web/src/features/alerts/RuleLibrary.tsx`
- Modify: `web/src/features/alerts/RuleLibrary.module.css`
- Modify: `web/src/features/alerts/RuleLibrary.test.tsx`
- Modify: `web/src/features/alerts/AlertsPanel.test.tsx:464`

**Interfaces:**
- Consumes: `TEMPLATE_GROUPS`, `type RuleExample`, `type TemplateGroup` from `./templates`.
- Produces: unchanged props `{ onUse, onBlank, onBack }`. DOM: `nav` labelled "Kinds of rule" with one button per kind (the kind's label); `section` per kind labelled by its `h4`; cards `data-testid="rule-template"` with `h5` title; info mark label = title; Use button `Use the <title> example (<label>)`.

- [ ] **Step 1: Rewrite the tests**

Replace the body of `RuleLibrary.test.tsx` with:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RuleLibrary } from './RuleLibrary';
import { CONDITION_LABELS, CONDITION_TYPES, type DraftRule } from './ruleDraft';
import { TEMPLATE_GROUPS } from './templates';

const library = (onUse = vi.fn<(draft: DraftRule) => void>()) => {
  const onBlank = vi.fn();
  const onBack = vi.fn();

  render(<RuleLibrary onUse={onUse} onBlank={onBlank} onBack={onBack} />);

  return { onUse, onBlank, onBack };
};

const group = (label: string) => screen.getByRole('region', { name: label });

describe('the rule library', () => {
  it('holds a section for every kind, each with its own examples under it', () => {
    library();

    for (const type of CONDITION_TYPES) {
      const label = CONDITION_LABELS[type];
      const expected = TEMPLATE_GROUPS.find((one) => one.type === type)!.examples;

      expect(within(group(label)).getByRole('heading', { name: label, level: 4 })).toBeInTheDocument();
      expect(within(group(label)).getAllByTestId('rule-template')).toHaveLength(expected.length);
    }
    expect(screen.getAllByTestId('rule-template')).toHaveLength(
      TEMPLATE_GROUPS.reduce((sum, one) => sum + one.examples.length, 0),
    );
  });

  it('says what each kind does once, under its heading', () => {
    library();

    expect(within(group('Silence')).getByText('No message for a set time.')).toBeInTheDocument();
  });

  it('moves to a kind from the chips at the top', async () => {
    library();

    const chips = screen.getByRole('navigation', { name: 'Kinds of rule' });
    await userEvent.click(within(chips).getByRole('button', { name: 'Pulse' }));

    expect(within(group('Pulse')).getByRole('heading', { name: 'Pulse', level: 4 })).toHaveFocus();
  });

  it('puts the story where the example was, behind the mark, and takes it away again', async () => {
    library();

    const card = screen.getByRole('heading', { name: 'Battery died' }).closest('li')!;

    expect(within(card).getByText('sensors/loft/temp')).toBeInTheDocument();
    expect(within(card).queryByRole('note')).not.toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'What Battery died means' }));

    expect(within(card).getByRole('note')).toHaveTextContent(/battery dies/);
    expect(within(card).queryByText('sensors/loft/temp')).not.toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Use the Battery died example (Silence)' }),
    ).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'Hide what Battery died means' }));

    expect(within(card).queryByRole('note')).not.toBeInTheDocument();
  });

  it('tells one story at a time, across every kind', async () => {
    library();

    await userEvent.click(screen.getByRole('button', { name: 'What Upper limit means' }));
    await userEvent.click(screen.getByRole('button', { name: 'What Clears with a margin means' }));

    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent(/1.2 and 2.3/);
  });

  it('starts from the example that was pressed, or from nothing, or goes back', async () => {
    const { onUse, onBlank, onBack } = library();

    await userEvent.click(screen.getByRole('button', { name: 'Use the Tukey fence example (Outlier)' }));

    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse.mock.calls[0][0]).toMatchObject({
      id: null,
      filter: 'sensors/flow/rate',
      condition: { type: 'outlier', method: 'tukey', k: '1.5' },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Blank rule' }));
    expect(onBlank).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
```

The save-as-it-stands and fresh-copy tests moved to `templates.test.ts` in Task 5.

In `AlertsPanel.test.tsx:464`, change the button name `'Use the Silence template'` to `'Use the Battery died example (Silence)'`. The assertions after it (`sensors/loft/temp`, `Loft sensor silent`) stay.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/alerts/RuleLibrary.test.tsx src/features/alerts/AlertsPanel.test.tsx`
Expected: FAIL — `TEMPLATES` import gone; no region named for a kind.

- [ ] **Step 3: Rewrite RuleLibrary.tsx**

```tsx
import { useId, useRef, useState } from 'react';
import { InfoMark } from '../../components/InfoTip';
import panel from '../../styles/panel.module.css';
import styles from './RuleLibrary.module.css';
import { CONDITION_LABELS, ruleOf, type ConditionType, type DraftRule } from './ruleDraft';
import { firesOn } from './ruleSummary';
import { TEMPLATE_GROUPS, type RuleExample } from './templates';

/**
 * A worked example of every setting of every kind of rule, to start from.
 *
 * It is offered beside New rule and never in front of it: somebody who knows what they want
 * presses New rule and gets an empty form, and somebody who does not can come here and leave with
 * a rule that already works on somebody's garage.
 *
 * Grouped under the kind, with the kind said once at its head, and a row of chips at the top to
 * reach a kind without scrolling past thirty cards. Every card is the same size, and stays that
 * size when its mark is pressed — the example gives way to the story rather than the card growing
 * under it. A grid whose cards change height is a grid whose other cards move while they are
 * being read.
 */
export function RuleLibrary({
  onUse,
  onBlank,
  onBack,
}: {
  onUse: (draft: DraftRule) => void;
  onBlank: () => void;
  onBack: () => void;
}) {
  // One story at a time across the whole library: the mark is a question about one card, and a
  // page of answers open at once is the prose the cards were made to avoid.
  const [told, setTold] = useState<string | null>(null);
  const headings = useRef(new Map<ConditionType, HTMLHeadingElement>());
  const base = useId();

  const jump = (type: ConditionType) => {
    const heading = headings.current.get(type);
    // Optional because jsdom has no scrolling; focus is what a keyboard reader is moved by anyway.
    heading?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    heading?.focus({ preventScroll: true });
  };

  return (
    <section aria-label="Rule library">
      <div className={panel.sectionTop}>
        <h3 className={panel.sectionTitle}>Rule library</h3>

        <div className={styles.ways}>
          <button type="button" onClick={onBack}>
            &larr; Back
          </button>
          <button type="button" onClick={onBlank}>
            Blank rule
          </button>
        </div>
      </div>

      <nav aria-label="Kinds of rule" className={styles.kinds}>
        {TEMPLATE_GROUPS.map((group) => (
          <button
            key={group.type}
            type="button"
            className={styles.kindChip}
            onClick={() => jump(group.type)}
          >
            {CONDITION_LABELS[group.type]}
          </button>
        ))}
      </nav>

      {TEMPLATE_GROUPS.map((group) => {
        const label = CONDITION_LABELS[group.type];
        const headingId = `${base}-${group.type}`;

        return (
          <section key={group.type} aria-labelledby={headingId} className={styles.group}>
            <div className={styles.groupHead}>
              <h4
                id={headingId}
                tabIndex={-1}
                className={styles.kind}
                ref={(element) => {
                  if (element) headings.current.set(group.type, element);
                  else headings.current.delete(group.type);
                }}
              >
                {label}
              </h4>
              <p className={styles.says}>{group.says}</p>
            </div>

            <ul className={styles.cards}>
              {group.examples.map((example) => {
                const key = `${group.type}:${example.title}`;

                return (
                  <Card
                    key={key}
                    example={example}
                    label={label}
                    open={told === key}
                    onTell={() => setTold((now) => (now === key ? null : key))}
                    onUse={() => onUse(example.draft())}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

function Card({
  example,
  label,
  open,
  onTell,
  onUse,
}: {
  example: RuleExample;
  label: string;
  open: boolean;
  onTell: () => void;
  onUse: () => void;
}) {
  const storyId = useId();
  // Read off the draft the card would hand over, in the words the rules table uses, so the
  // example on the card and the row it turns into cannot say two different things.
  const rule = ruleOf(example.draft());

  return (
    <li className={styles.card} data-testid="rule-template">
      <div className={styles.cardHead}>
        <h5 className={styles.title}>{example.title}</h5>
        <InfoMark
          label={example.title}
          open={open}
          controls={open ? storyId : undefined}
          onToggle={onTell}
        />
      </div>

      {open ? (
        <div id={storyId} className={styles.story} role="note">
          <span className={styles.storyLabel}>Real example</span>
          <p>{example.story}</p>
        </div>
      ) : (
        <div className={styles.example}>
          <span className={styles.exampleTopic}>{rule.filter}</span>
          <span>{firesOn(rule)}</span>
        </div>
      )}

      <button
        type="button"
        className={styles.use}
        aria-label={`Use the ${example.title} example (${label})`}
        onClick={onUse}
      >
        Use
      </button>
    </li>
  );
}
```

`firesOn` already names the field (`battery < 20`), so the card does not repeat it.

- [ ] **Step 4: Update the CSS**

In `RuleLibrary.module.css`, change the `.card` height comment and value, rename the card heading class, and add the new classes:

```css
/* A fixed height, not a minimum: cards with one-line and three-line examples would otherwise be
   different sizes, and a card whose mark is pressed would push the row under it down the page. */
.card {
  /* …unchanged properties… */
  height: 12.5rem;
}

/* One chip a kind, wrapping on a narrow panel rather than scrolling sideways. */
.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 16px;
}
.kindChip {
  padding: 4px 10px;
  font-size: var(--t-small);
}

.group { margin: 0 0 20px; }
.group:last-child { margin-bottom: 0; }

.groupHead {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0 0 10px;
  /* The chips scroll a heading to the top; this keeps it clear of the panel's own edge. */
  scroll-margin-top: 12px;
}

/* .kind keeps its existing rules: it is now the group heading. */
.kind:focus { outline: none; }
.kind:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

.title {
  margin: 0;
  font-size: var(--t-body);
  font-weight: 600;
  color: var(--ink);
}
```

Keep `.says`, `.example`, `.exampleTopic`, `.story`, `.storyLabel`, `.use`, `.ways`, `.cards`, `.cardHead` as they are. `--signal`, `--t-body` and `--t-small` are the tokens in `web/src/styles/tokens.css`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/features/alerts/ src/a11ySweeps.test.tsx src/namedClasses.test.ts`
Expected: PASS.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/alerts/RuleLibrary.tsx web/src/features/alerts/RuleLibrary.module.css web/src/features/alerts/RuleLibrary.test.tsx web/src/features/alerts/AlertsPanel.test.tsx
git commit -m "feat: the rule library is a section per kind, said once at its head with its examples under it and a row of chips to reach any kind, so thirty-odd examples read as eleven kinds rather than one long grid"
```

---

### Task 7: Whole-suite check and a look in the running app

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run the whole web suite and the type check**

Run: `npx vitest run` then `npx tsc -b` (from `web/`).
Expected: all pass. A file that times out at 5 s under load: rerun it alone (`npx vitest run <file>`) before treating it as a failure.

- [ ] **Step 2: Look at it in the browser**

Start the app's dev servers through `.claude/launch.json` with the preview tools (never via Bash). In the Alerts panel:
1. Library → chips jump to each kind; each kind shows its heading, its line and its cards; a story opens and closes; Use on "Is exactly" opens the editor with How it matches = Is exactly, Text = OFFLINE.
2. In that editor, switch How it matches through every option and check the Saved as line; type into the any-of-words box with Enter between words; switch to Regular expression and back.
3. With a topic receiving messages, set the rule's filter to it and press Refresh in Try it; check rows, verdicts, the field-missing skip with a field set, and an invalid expression such as `([`.
4. Narrow the window to phone width: chips wrap, no sideways scroll.

Take a screenshot of the library and one of the pattern editor with Try it filled in.

- [ ] **Step 3: Stop the dev servers**

`preview_stop` both servers, so port 5169 is free for the user.

- [ ] **Step 4: Commit any fixes**

Only if Steps 1–2 needed changes; one commit per fix, in the same style.
