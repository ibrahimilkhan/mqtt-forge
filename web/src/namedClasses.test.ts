import { describe, expect, it } from 'vitest';

/**
 * Every class the markup names has to exist in the stylesheet it is named out of.
 *
 * A CSS module hands back a plain object, so `styles.whatever` for a class nobody wrote is
 * `undefined` — and `className={undefined}` renders `class="undefined"`, which is valid markup
 * that matches no rule. Nothing complains. TypeScript cannot see inside a `.css` file, the build
 * does not care, and no test in this repo asserts a computed style, so the element simply draws
 * itself with whatever it inherits and looks plausible enough that nobody opens it again.
 *
 * It had already happened: the rail's alert badge carried `styles.menuCount` and `.menuCount` had
 * never been written. For as long as that shipped, a console with three critical alarms standing
 * drew the number as a bare grey digit immediately after the row's own name — ALERTS 3, a row
 * that looked like it was called that — with no box, no colour and no severity.
 *
 * This is the sweep that would have caught it on the first run. It reads the stylesheets rather
 * than the rendered page, because the failure is invisible by construction in both.
 */

/** Every CSS module in the app, by the path a component would import it at. */
const sheets = import.meta.glob('./**/*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every component, so the imports can be matched to the sheets above. */
const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The class names a stylesheet actually defines, `composes:` targets included. */
function defined(css: string): Set<string> {
  const found = new Set<string>();
  for (const [, name] of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(name);
  return found;
}

/** Resolves a relative import against the file that wrote it, without a path library. */
function resolve(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const step of spec.split('/')) {
    if (step === '.') continue;
    else if (step === '..') parts.pop();
    else parts.push(step);
  }
  return parts.join('/');
}

/**
 * Every `binding.name` a component reads off a stylesheet it imported.
 *
 * Only the dotted form. A computed `styles[whatever]` cannot be checked without running the
 * thing, and the two in this app are both indexed by a union the type checker already holds.
 */
function used(): Array<{ file: string; sheet: string; name: string }> {
  const all: Array<{ file: string; sheet: string; name: string }> = [];

  for (const [file, source] of Object.entries(sources)) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;

    for (const [, binding, spec] of source.matchAll(
      /import\s+(\w+)\s+from\s+'([^']+\.module\.css)'/g,
    )) {
      const sheet = resolve(file, spec);
      const reads = new RegExp(String.raw`\b${binding}\.([A-Za-z_]\w*)`, 'g');
      for (const [, name] of source.matchAll(reads)) all.push({ file, sheet, name });
    }
  }

  return all;
}

describe('the classes the markup names', () => {
  // A floor, so a sweep that stopped finding anything — a renamed import form, a changed glob —
  // fails rather than passing by looking at nothing.
  it('is reading a real number of them', () => {
    const reads = used();

    expect(reads.length).toBeGreaterThan(300);
    expect(new Set(reads.map((read) => read.file)).size).toBeGreaterThan(20);
    expect(Object.keys(sheets).length).toBeGreaterThan(15);
  });

  it('are all defined in the stylesheet they are named out of', () => {
    const holes = used().filter(({ sheet, name }) => {
      const css = sheets[sheet];
      // A missing sheet is its own failure and is reported by the next case.
      return css !== undefined && !defined(css).has(name);
    });

    expect(holes.map((hole) => `${hole.file} names ${hole.name}`)).toEqual([]);
  });

  it('are named out of stylesheets that exist', () => {
    const missing = used().filter(({ sheet }) => sheets[sheet] === undefined);

    expect(missing.map((hole) => `${hole.file} imports ${hole.sheet}`)).toEqual([]);
  });
});
