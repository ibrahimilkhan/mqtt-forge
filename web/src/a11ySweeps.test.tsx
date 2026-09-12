import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';
import { PANELS } from './features/panels';
import { useLogStore } from './stores/logStore';
import { useSearchStore } from './stores/searchStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTopicTreeStore } from './stores/topicTreeStore';
import type { MqttMessage } from './types/api';

/**
 * Rules swept over the whole console rather than asserted one control at a time.
 *
 * Both of the ones here are habits rather than bugs — the next helpful aria-label will be written
 * the same way, and the next disclosure will name a body that is not mounted — so a test that
 * only knew today's controls would not be there to catch the next one.
 *
 * ---- a button that shows a word must answer to it ----
 *
 * This is WCAG 2.5.3, Label in Name, and it is not a formality — it is the difference between
 * 'click stop stream' working and not working for anybody driving the console by voice, and
 * between a screen reader's button list matching the screen and contradicting it. The failures
 * it catches are always the same shape: someone writes a helpful aria-label that describes the
 * action, and the description shares no word with the label printed on the control. Four range
 * chips, the stream control, a save-folder button and a search's clear were all found this way
 * on one afternoon.
 *
 * Written as a sweep rather than as a case per control because the failure is a habit rather
 * than a bug: the next helpful aria-label will be written the same way, and a test that only
 * knows today's controls will not be there to catch it.
 */
const message = (topic: string, payload: string): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain: false,
  receivedAt: '2026-09-12T01:00:00Z',
});

/**
 * A console with something in it.
 *
 * Most of the interesting controls do not exist on an empty one: the range chips want a chart
 * with readings under it, the log's tools want a selection, and every clear-the-search wants
 * something typed. A sweep over the opening state would be a sweep over eight buttons.
 */
const openBusyConsole = async () => {
  const hub = createFakeHub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App hub={hub} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Close Broker panel' });

  act(() =>
    hub.emit(
      'messagesReceived',
      [21.5, 22.1, 22.4, 21.9, 23.2, 24.8].map((value, i) =>
        message(i % 2 === 0 ? 'plant/kiln/temp' : 'plant/kiln/pressure', String(value)),
      ),
    ),
  );
  useSelectionStore.getState().select({
    label: 'temp',
    filter: 'plant/kiln/temp',
    topic: 'plant/kiln/temp',
  });
  // Typed, so every clear-the-search is drawn. The boxes themselves are opened by a mark on a
  // head row; the store behind them is the same one those marks write to.
  useSearchStore.setState({
    log: { look: 'kiln', where: 'both' },
    tree: { look: 'kiln', where: 'both' },
  });
};

/**
 * The label a reader sees on the control.
 *
 * Not simply its text: a control's visible text is not all label. The log's fold shows its own
 * count beside its name — '▾ Log (3 of 3)' — and a count is a reading rather than something a
 * person says to press the thing, so anything in brackets comes off before the comparison.
 */
const visible = (button: HTMLElement): string =>
  (button.textContent ?? '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Whether a visible string is a word rather than a mark or a number.
 *
 * The criterion is about text labels. A ×, a chevron, a twisty and a bare count are not labels a
 * reader can say, and the accessible name is the only name those have.
 */
const isWord = (text: string) => /[a-z]{2}/i.test(text);

/**
 * Letters and digits, lowercased, everything else a space.
 *
 * Compared as a substring and not word by word, which is what the criterion asks for and what
 * speech software actually does: a chip printed 'dist' and named 'Distribution' is reachable by
 * saying what is on it, and a word-by-word test would call that a failure.
 */
const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const judged = () =>
  screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-label') !== null && isWord(visible(button)));

const offenders = () =>
  judged()
    .map((button) => {
      const shown = visible(button);
      const named = button.getAttribute('aria-label') ?? '';
      return bare(named).includes(bare(shown)) ? null : { shown, named };
    })
    .filter(Boolean);

/**
 * How many controls a sweep has to have looked at before its silence means anything.
 *
 * Without a floor the test passes just as happily when a selector stops matching, a panel fails
 * to open, or every button on the page loses its aria-label — which is the failure mode of every
 * sweep ever written.
 *
 * Two floors, because there are two contexts. Three of the eight panels take the whole window and
 * hide the workspace behind them, so with one of those open the page holds the rail, the panel
 * and nothing else. The rich sweep is the one with every panel shut, where the tree, the log, the
 * chart and the publish form are all drawn at once.
 */
const ENOUGH = 1;
const ENOUGH_WITH_THE_WORKSPACE_UP = 10;

beforeEach(() => {
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useSelectionStore.setState({ selected: null });
  useSearchStore.setState({ log: { look: '', where: 'both' }, tree: { look: '', where: 'both' } });
});

describe('every control answers to the word printed on it', () => {
  it.each(PANELS.map((panel) => panel.label))('holds with the %s panel open', async (label) => {
    await openBusyConsole();

    // Only when it is not already the open one: the rail's rows toggle, and the console opens on
    // the Broker panel — so a plain click on that row shuts the thing this is about. By prefix,
    // because the Broker row says what the link is doing as well as its name.
    const menu = within(screen.getByRole('navigation', { name: 'Panels' }));
    if (screen.queryByRole('region', { name: `${label} panel` }) === null) {
      await userEvent.click(menu.getByRole('button', { name: new RegExp(`^${label}`) }));
    }
    await screen.findByRole('region', { name: `${label} panel` });

    expect(judged().length).toBeGreaterThanOrEqual(ENOUGH);
    expect(offenders()).toEqual([]);
  });

  it('holds with every panel shut, which is where the traffic is', async () => {
    await openBusyConsole();

    await userEvent.click(screen.getByRole('button', { name: 'Close Broker panel' }));

    expect(judged().length).toBeGreaterThanOrEqual(ENOUGH_WITH_THE_WORKSPACE_UP);
    expect(offenders()).toEqual([]);
  });
});

/**
 * An aria-controls has to name something that is in the document.
 *
 * A reference to an id that is not there is a promise a screen reader cannot keep: it offers the
 * reader a way to the thing and lands them nowhere. Every InfoMark in the alerts editor was doing
 * it — twenty dangling references on one panel — because the help body is mounted on `open` and
 * the attribute was not, and the same was true of a folded region's strip.
 */
const dangling = () =>
  [...document.querySelectorAll('[aria-controls]')]
    .filter((el) => document.getElementById(el.getAttribute('aria-controls') ?? '') === null)
    .map((el) => ({
      id: el.getAttribute('aria-controls'),
      name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
    }));

describe('every aria-controls names something that is there', () => {
  it.each(PANELS.map((panel) => panel.label))('holds with the %s panel open', async (label) => {
    await openBusyConsole();

    const menu = within(screen.getByRole('navigation', { name: 'Panels' }));
    if (screen.queryByRole('region', { name: `${label} panel` }) === null) {
      await userEvent.click(menu.getByRole('button', { name: new RegExp(`^${label}`) }));
    }
    await screen.findByRole('region', { name: `${label} panel` });

    expect(dangling()).toEqual([]);
  });

  /**
   * The alerts rule editor, which is where the marks are.
   *
   * Twenty of the twenty dangling references were in this one form, and none of them exist until
   * a reader presses New rule — so a sweep of the panels alone walks straight past the thing it
   * was written for. Both halves are held here: shut, a mark names nothing; open, it names the
   * body that is now on screen.
   */
  it('holds in the rule editor, where every one of them was wrong', async () => {
    await openBusyConsole();

    const menu = within(screen.getByRole('navigation', { name: 'Panels' }));
    await userEvent.click(menu.getByRole('button', { name: /^Alerts/ }));
    const alerts = within(await screen.findByRole('region', { name: 'Alerts panel' }));
    await userEvent.click(await alerts.findByRole('button', { name: /New rule/i }));

    const marks = await screen.findAllByRole('button', { name: /means$/ });
    expect(marks.length).toBeGreaterThanOrEqual(3);
    expect(dangling()).toEqual([]);

    await userEvent.click(marks[0]);

    const named = marks[0].getAttribute('aria-controls');
    expect(named).toBeTruthy();
    expect(document.getElementById(named ?? '')).not.toBeNull();
    expect(dangling()).toEqual([]);
  });
});
