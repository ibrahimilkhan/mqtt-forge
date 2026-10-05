import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Not `new URL('..', import.meta.url)`: Vite rewrites that literal to an asset URL under Vitest.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

const cssFiles = () =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => join(SRC, entry));

/**
 * Every declaration block in the file, with the selector that opens it.
 *
 * Comments are stripped first, and that is not tidying: the rule this file exists to protect
 * carries a comment explaining what `position: absolute` does to a pane, and a matcher reading
 * comments found the words there and passed a stylesheet that had lost the declaration.
 */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const found: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selector, body] of bare.matchAll(pattern)) {
    found.push({ selector: selector.trim().replace(/\s+/g, ' '), body });
  }
  return found;
}

/** Every `@media` block in the file: its condition, whitespace folded, and the rules inside it. */
function mediaBlocks(css: string): { condition: string; rules: { selector: string; body: string }[] }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const found: { condition: string; rules: { selector: string; body: string }[] }[] = [];
  for (const media of bare.matchAll(/@media([^{]*)\{/g)) {
    // The block runs to the brace that closes the one @media opened.
    let depth = 1;
    let at = media.index! + media[0].length;
    const start = at;
    while (depth > 0 && at < bare.length) {
      if (bare[at] === '{') depth++;
      if (bare[at] === '}') depth--;
      at++;
    }
    found.push({ condition: media[1].trim().replace(/\s+/g, ' '), rules: rules(bare.slice(start, at - 1)) });
  }
  return found;
}

const read = (file: string) => readFileSync(cssFiles().find((f) => f.endsWith(file))!, 'utf8');

const conditionsWith = (file: string, selector: RegExp, body: RegExp) =>
  mediaBlocks(read(file))
    .filter((block) => block.rules.some((rule) => selector.test(rule.selector) && body.test(rule.body)))
    .map((block) => block.condition);

/**
 * The console is one screen wherever it is used with a mouse, and scrolls as a page only on a
 * touch screen too narrow for columns.
 *
 * Above that point the panes are columns splitting one screen between them, and the body's height
 * is what makes the screen one screen: take it away and every row sizes itself to its content, and
 * a log's opened history stretches the whole console down the page under a page-level scrollbar.
 *
 * That is not hypothetical, twice over. The workspace's stacking point moved from 1180px to 760px —
 * two columns with the panel laid over them fit a laptop fine — and global.css went on releasing
 * the body at 1180; between the two, which is where a desktop window at 125% lives, the console was
 * columns on a page of any height, seventeen thousand pixels of it with one history open. And below
 * 760 the stacked page was right for the phone it was drawn for and wrong for a desktop window that
 * had only been made narrow, where there is a mouse and the page scrolling out from under the
 * panes is exactly what the reader asked not to have.
 */
describe('the page', () => {
  it('lets go of its height only where the workspace stacks', () => {
    const releases = conditionsWith('global.css', /^body$/, /height:\s*auto/);
    const stacks = conditionsWith('Workspace.module.css', /(^|,\s*)\.grid(,|$)/, /grid-template-columns:\s*1fr\s*;/);

    expect(stacks).toHaveLength(1);
    expect(releases).toEqual(stacks);
  });

  it('never scrolls under a mouse', () => {
    // Each of these hands the scrolling from the panes to the page: the body sized to its content,
    // a pane that stops clipping, a workspace put into one column of content-sized rows.
    const pageScrolling = [
      { selector: /^body$/, body: /height:\s*auto/ },
      { selector: /./, body: /overflow-y:\s*visible/ },
      { selector: /(^|,\s*)\.grid(,|$)/, body: /grid-template-columns:\s*1fr\s*;/ },
    ];

    const offenders = cssFiles().flatMap((file) =>
      mediaBlocks(readFileSync(file, 'utf8'))
        .filter((block) => block.rules.some((rule) => pageScrolling.some((p) => p.selector.test(rule.selector) && p.body.test(rule.body))))
        .filter((block) => !/pointer:\s*coarse/.test(block.condition))
        .map((block) => `${file.slice(SRC.length + 1)}: @media ${block.condition}`),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps the laptop layout in a narrow window under a mouse', () => {
    // The panel lies over the two columns rather than taking a third — the layout a window between
    // 761 and 1180 already has, and the one a window made narrower than that keeps. With no pointer
    // at all too: nothing else claims such a screen below 760, and unclaimed it would be the three
    // wide columns squeezed into it.
    const overlay = conditionsWith('Workspace.module.css', /\.grid\[data-panel='open'\] > \.pane:first-child$/, /position:\s*absolute/);

    expect(overlay).toHaveLength(1);
    expect(overlay[0]).toContain('(max-width: 760px) and (pointer: fine)');
    expect(overlay[0]).toContain('(max-width: 760px) and (pointer: none)');
    expect(overlay[0]).toContain('(min-width: 761px) and (max-width: 1180px)');
  });
});

/**
 * The console is one screen: the panes scroll, the page does not. That holds only while every
 * scrolling pane is also a containing block.
 *
 * The panes are full of `position: absolute` boxes that nothing places — the visually-hidden
 * headings and the per-row controls that keep the rows reachable from a keyboard. A box like
 * that anchors to the nearest positioned ancestor, and where there is none it anchors to the
 * page, which `overflow` on the pane cannot clip: the box keeps its place in the flow and the
 * document grows to reach it. Opening the log's history put twenty-five of them four thousand
 * pixels down, and the page grew a screenful of empty scroll under a layout that had not moved.
 *
 * Only for the panes that hold `.srOnly`. A window that is itself `position: fixed` already
 * gives its contents a containing block, and cannot extend the document whatever is in it.
 */
describe('a pane that scrolls its own content', () => {
  const SCROLLING = /overflow(-y)?:\s*(auto|scroll)/;
  const POSITIONED = /position:\s*(relative|absolute|fixed|sticky)/;

  const panes = ['App.module.css', 'PanelShell.module.css'];

  it.each(panes)('is a containing block in %s', (file) => {
    const css = readFileSync(cssFiles().find((f) => f.endsWith(file))!, 'utf8');
    const scrollers = rules(css).filter((rule) => SCROLLING.test(rule.body));

    expect(scrollers.length).toBeGreaterThan(0);
    for (const rule of scrollers) {
      expect(rule.body, `${rule.selector} scrolls but is not positioned`).toMatch(POSITIONED);
    }
  });
});
