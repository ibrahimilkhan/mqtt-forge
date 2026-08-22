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
