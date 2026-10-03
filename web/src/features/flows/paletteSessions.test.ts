import { describe, expect, it } from 'vitest';
import { overlapsIn, randomSession, wrongWith } from './wireTestbed';

/*
 * Sessions of the palette as a reader might click them, at random, from a new flow: a node of every
 * type the palette has, put on a wire picked, or after a node picked — free in the view when that
 * node has no one way out, as the page puts it — and now and then a node dragged off its row to
 * somewhere clear. After every step, as the canvas would draw it, nothing may stand on anything: no
 * node on another, no wire — drawn round or the curve — through a node but its own two or through a
 * port's name, and no two wires drawn round on one line, or closer than 16 beside each other, but
 * where they go into one port together (see wrongWith).
 *
 * Drawings found one at a time each held, and the next one a reader clicked together did not: a
 * review clicking at random found one session in sixteen with a node on another, and one in eight
 * with a wire through a node. So the drawings are made by the hundred, each from a seed, and one that
 * goes wrong is told by its seed and its steps, to be clicked again by hand or made a case of its own.
 */

/** How many sessions, how long each, and the seed of the first: the same sessions on every run. */
const SESSIONS = 300;
const STEPS = 7;
const FIRST_SEED = 20261003;

/**
 * Sessions past the first SESSIONS that runs of three thousand found going wrong, each once one thing
 * the palette or the routes do was undone, which the first SESSIONS never showed: a node put down free,
 * or dragged, a wire's margin from another and not the wider room (20261846, 20261989); the names
 * beside the ports left out of what crowds a node (20262043, 20262114); and the routes worked out once,
 * with no second plan for the wires that found no way (20262313). Replayed on every run.
 */
const PINNED = [20261846, 20261989, 20262043, 20262114, 20262313];

/** A session's seed, its steps up to the first that left something wrong, and what was wrong then; null when nothing was. */
function wrongIn(seed: number) {
  const steps: string[] = [];
  for (const { step, flow } of randomSession(seed, STEPS)) {
    steps.push(step);
    const wrong = [...overlapsIn(flow), ...wrongWith(flow)];
    if (wrong.length > 0) return `seed ${seed}: ${steps.join('; ')}\n    ${wrong.join('\n    ')}`;
  }
  return null;
}

describe('the palette, clicked at random', () => {
  it(`leaves nothing on anything in ${SESSIONS} sessions of ${STEPS} steps`, () => {
    const failed = Array.from({ length: SESSIONS }, (_, at) => wrongIn(FIRST_SEED + at)).filter((told) => told !== null);

    expect(failed.length, `${failed.length} of ${SESSIONS} sessions went wrong; the first:\n${failed.slice(0, 5).join('\n')}`).toBe(0);
  });

  it.each(PINNED)('leaves nothing on anything in session %i, which a larger run found going wrong', (seed) => {
    expect(wrongIn(seed)).toBeNull();
  });
});
