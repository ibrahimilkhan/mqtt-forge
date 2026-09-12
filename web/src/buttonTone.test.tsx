import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';
import { PANELS } from './features/panels';

/**
 * What a press does, in three colours — checked as a vocabulary rather than as pixels.
 *
 * Every button in this console was one colour, so the only thing its colour said was 'this is a
 * button': a reader scanning a panel for the way out of it, or for the one control that cannot be
 * undone, had to read every word on the row. The three tones are declared in global.css and
 * carried by one custom property, so the colour itself is one line of CSS. What is worth holding
 * is the classification — which word gets which — because that is the part that goes on being
 * decided, one button at a time, by whoever adds the next one.
 *
 * Named rather than swept. A sweep cannot tell a filled button from an icon built with
 * `all: unset` without CSS, and jsdom has none: the first version of this test filtered on
 * `borderStyle` and quietly judged nothing at all.
 */
const TONES: ReadonlyArray<[name: RegExp, tone: 'starts' | 'ends' | 'keeps']> = [
  // Something begins.
  [/^Connect$/, 'starts'],
  [/^Publish$/, 'starts'],
  [/^Subscribe$/, 'starts'],
  [/^New rule$/, 'starts'],
  [/^Add a condition$/, 'starts'],
  [/^Try again$/, 'starts'],
  // Something goes.
  [/^Disconnect$/, 'ends'],
  [/^Abort$/, 'ends'],
  [/^Clear traffic$/, 'ends'],
  [/^Clear events$/, 'ends'],
  [/^Clear retained$/, 'ends'],
  [/^Discard it$/, 'ends'],
  // What is on screen is kept, which is neither.
  [/^Save$/, 'keeps'],
];

const openConsole = async () => {
  const hub = createFakeHub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App hub={hub} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Close Broker panel' });
};

const toneOf = (button: HTMLElement) =>
  button.classList.contains('ends') ? 'ends' : button.classList.contains('starts') ? 'starts' : 'keeps';

/** Every classified button on screen right now, with the tone it is actually wearing. */
const onScreen = () =>
  TONES.flatMap(([name, tone]) =>
    screen.queryAllByRole('button', { name }).map((button) => ({
      name: (button.getAttribute('aria-label') || button.textContent || '').trim(),
      want: tone,
      has: toneOf(button),
    })),
  );

describe('a button says what pressing it does', () => {
  it.each(PANELS.map((panel) => panel.label))('holds in the %s panel', async (label) => {
    await openConsole();

    const menu = within(screen.getByRole('navigation', { name: 'Panels' }));
    if (screen.queryByRole('region', { name: `${label} panel` }) === null) {
      await userEvent.click(menu.getByRole('button', { name: new RegExp(`^${label}`) }));
    }
    await screen.findByRole('region', { name: `${label} panel` });

    expect(onScreen().filter((seen) => seen.has !== seen.want)).toEqual([]);
  });

  /**
   * And it is not judging an empty room.
   *
   * The console opens on the broker panel, which takes the whole window — so what is on screen at
   * that moment is Connect and Save, one of each of two tones, and that is the floor that proves
   * the selectors still find anything at all.
   */
  it('finds the two the console opens with, each wearing its own tone', async () => {
    await openConsole();

    const seen = onScreen();
    expect(seen.map((one) => one.name).sort()).toEqual(['Connect', 'Save']);
    expect(seen.filter((one) => one.has !== one.want)).toEqual([]);
    expect(new Set(seen.map((one) => one.want))).toEqual(new Set(['starts', 'keeps']));
  });

  // And with a panel that leaves the workspace up, the publish form comes with it.
  it('finds the workspace ones once a panel stops covering it', async () => {
    await openConsole();

    const menu = within(screen.getByRole('navigation', { name: 'Panels' }));
    await userEvent.click(menu.getByRole('button', { name: /^Filters/ }));
    await screen.findByRole('region', { name: 'Filters panel' });

    const seen = onScreen();
    expect(seen.map((one) => one.name).sort()).toEqual(['Publish', 'Subscribe']);
    expect(seen.every((one) => one.has === 'starts')).toBe(true);
  });
});
