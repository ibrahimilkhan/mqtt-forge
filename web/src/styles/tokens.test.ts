import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

/**
 * The colours the console letters with, measured against the two grounds it draws them on.
 *
 * Every ink in this palette was tuned against --surface, which is white, and every panel body in
 * the console is --paper, which is not. The gap is small and it is enough: --muted was 4.83:1 on
 * the surface and 4.11:1 on the paper, and --muted is the colour of every field label, every
 * hint, every note, every section title and every close × in the product. --warn was 4.59 and
 * 3.91, under a comment stating the requirement it was failing to meet everywhere it is actually
 * spent.
 *
 * A test rather than a note, because the failure is invisible by construction: the colour looks
 * right in the one place it was chosen, and wrong nowhere anybody would think to look.
 *
 * Read out of the stylesheet rather than restated here, so it cannot drift from what ships.
 */
const tokens = (() => {
  const found: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[name] = value.toLowerCase();
  }
  return found;
})();

const luminance = (hex: string): number => {
  const channel = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrast = (a: string, b: string): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

/** WCAG AA for text below 18.66px, which is every size on this console's scale. */
const AA = 4.5;

const round = (n: number) => Math.round(n * 100) / 100;

describe('the palette holds on both grounds', () => {
  it('reads the tokens it is about out of the stylesheet', () => {
    expect(tokens.paper).toBe('#eaedf1');
    expect(tokens.surface).toBe('#ffffff');
    expect(Object.keys(tokens)).toEqual(
      expect.arrayContaining(['ink', 'muted', 'signal', 'live', 'fault', 'warn', 'rule']),
    );
  });

  // Every one of these is lettering somewhere: --ink and --muted everywhere, --signal on the
  // wordmark and the links, --live on CONNECTED, --fault on a failure sentence, --warn on a
  // severity. --rule is not in the list on purpose — it is a hairline, and the one place it was
  // spent as type is now --muted (see TrafficChart.module.css, the note's empty slot).
  it.each(['ink', 'muted', 'signal', 'live', 'fault', 'warn'])(
    '--%s is readable on the paper a panel is drawn on',
    (name) => {
      expect(round(contrast(tokens[name], tokens.paper))).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each(['ink', 'muted', 'signal', 'live', 'fault', 'warn'])(
    '--%s is readable on the surface a pane is drawn on',
    (name) => {
      expect(round(contrast(tokens[name], tokens.surface))).toBeGreaterThanOrEqual(AA);
    },
  );

  // The hairline is not lettering, and a test that let it pass as one would be a test that had
  // stopped meaning anything.
  it('does not accidentally pass the hairline as an ink', () => {
    expect(contrast(tokens.rule, tokens.surface)).toBeLessThan(AA);
  });
});
