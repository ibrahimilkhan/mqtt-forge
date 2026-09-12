import { describe, expect, it } from 'vitest';
import css from './TopicTree.module.css?raw';
import tokens from '../../styles/tokens.css?raw';
import { PALETTE } from '../colours/palette';

/**
 * The reader's colour rules, on the two tree rows that are not white.
 *
 * The palette states its own contract in its doc comment — "the lightness is held where each one
 * still clears 4.5:1 against the white a row is drawn on" — and tokens.test.ts holds every colour
 * in the app's own palette to the same line. Neither covers this: the tree has two row states
 * that put a ground under the name, and on both of them every one of the eight fell under it.
 * Measured before this was fixed: on the selected row's --rule fill, Rose and Lilac at 3.41 and
 * Teal, the best of them, at 4.09; on the active row's ink-at-9%, five of the eight under 4.5.
 *
 * The remedy is the one the rest of that stylesheet already uses for --muted and for the '='
 * between a topic and its value: move the ink toward --ink by the distance the ground moved. What
 * cannot be checked by rendering — jsdom resolves neither color-mix nor a custom property through
 * one — is whether the distance is still far enough, so the percentages are read out of the
 * stylesheet and the arithmetic is done here.
 */

const AA = 4.5;

function hex(colour: string): [number, number, number] {
  const at = colour.trim();
  return [1, 3, 5].map((i) => parseInt(at.slice(i, i + 2), 16)) as [number, number, number];
}

function token(name: string): [number, number, number] {
  const found = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!found) throw new Error(`--${name} is gone from tokens.css`);
  return hex(found[1]);
}

const channel = (value: number) => {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `color-mix(in srgb, <colour> N%, <other>)`, as the browser computes it for opaque colours. */
function mix(
  colour: [number, number, number],
  other: [number, number, number],
  share: number,
): [number, number, number] {
  return colour.map((value, i) => Math.round(value * share + other[i] * (1 - share))) as [
    number,
    number,
    number,
  ];
}

/** The share a rule mixes the reader's colour at, read out of the stylesheet rather than restated. */
function share(selector: string): number {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`${selector} is gone from TopicTree.module.css`);

  const found = css
    .slice(at, css.indexOf('}', at))
    .match(/color-mix\(in srgb, var\(--rule-colour\) (\d+)%, var\(--ink\)\)/);
  if (!found) throw new Error(`${selector} no longer moves --rule-colour toward the ink`);

  return Number(found[1]) / 100;
}

const INK = token('ink');
const SURFACE = token('surface');
const RULE = token('rule');

/** The ground each state actually puts under the name, flattened onto the pane's own white. */
const GROUNDS = {
  // .node { } — the pane's ground, which is what the palette was tuned against.
  plain: { ground: SURFACE, at: 1 },
  // .node[data-active="true"] { background: color-mix(in srgb, var(--ink) 9%, transparent); }
  active: { ground: mix(INK, SURFACE, 0.09), at: share('.node[data-active="true"] .seg[data-ruled]') },
  // .node[data-selected="true"] { background: var(--rule); }
  selected: { ground: RULE, at: share('.node[data-selected="true"] .seg[data-ruled]') },
};

describe('a colour rule on a tree row', () => {
  for (const [state, { ground, at }] of Object.entries(GROUNDS)) {
    it(`is readable on the ${state} row`, () => {
      const failing = PALETTE.filter(
        (colour) => contrast(mix(hex(colour.value), INK, at), ground) < AA,
      ).map((colour) => `${colour.name} ${contrast(mix(hex(colour.value), INK, at), ground).toFixed(2)}`);

      expect(failing).toEqual([]);
    });
  }

  // A floor, so a sweep that stopped reading the stylesheet passes by looking at nothing.
  it('is checked against every colour the palette offers', () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(GROUNDS.active.at).toBeLessThan(1);
    expect(GROUNDS.selected.at).toBeLessThan(GROUNDS.active.at);
  });
});
