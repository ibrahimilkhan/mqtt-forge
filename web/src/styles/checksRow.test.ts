import { describe, expect, it } from 'vitest';
import css from './panel.module.css?raw';

/**
 * The one rule that decides whether `.trailing` reaches the end of its row.
 *
 * `.checks label` exists to cancel the 6px the global label rule leaves under itself for the box
 * it names — a label on this row names nothing below it. Written as the `margin` shorthand it
 * cancelled the inline sides too, and at two classes it outranks `.trailing`'s one: Retain kept
 * its place beside QoS 2 with `margin-left: auto` set and computing to 0.
 *
 * Read out of the stylesheet, because nothing in jsdom resolves this cascade — the browser it
 * shipped wrong in is the only place the failure was visible.
 */
const block = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`${selector} is gone from panel.module.css`);
  return css.slice(at, css.indexOf('}', at));
};

describe('the row of checks', () => {
  it('cancels the label gap without also cancelling the inline margins', () => {
    const rule = block('.checks label');

    expect(rule).toMatch(/margin-block:\s*0/);
    expect(rule).not.toMatch(/^\s*margin:/m);
  });

  it('has something that goes to the end of the row', () => {
    expect(block('.trailing')).toMatch(/margin-left:\s*auto/);
  });
});
