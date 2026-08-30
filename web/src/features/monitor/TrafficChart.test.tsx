import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { runsOf, type LogEntry } from '../../stores/logStore';
import { TrafficChart } from './TrafficChart';

// The chart takes one run per topic now. These tests still build a selection as one sequence,
// which is how a reader thinks of it, and this is the grouping the log itself does.
const asRuns = (entries: LogEntry[]) => runsOf(entries);

let nextId = 0;

// Newest first, the order the log holds them in, ending however long ago the caller says.
const run = (endedAgo: number, count = 8): LogEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    id: nextId++,
    kind: 'recv' as const,
    at: new Date(Date.now() - endedAgo - i * 1000),
    topic: 'sensors/temp',
    body: `${20 + (i % 3)}`,
  }));

beforeEach(() => {
  useAppearanceStore.getState().reset();
});

describe('TrafficChart', () => {
  it('marks a topic with a rhythm as silent once it falls behind it', () => {
    render(<TrafficChart runs={asRuns(run(60_000))} />);

    expect(screen.getByTestId('reading-silence').textContent).not.toBe('—');
  });

  // Held, the newest reading on show gets older by the second while the topic may be publishing
  // perfectly well behind the hold. An alarm then would be an alarm about the reader's own hand.
  it('raises no alarm about silence while the pane is being held still', () => {
    render(<TrafficChart runs={asRuns(run(60_000))} frozen />);

    expect(screen.getByTestId('reading-silence').textContent).toBe('—');
  });

  it('still charts the run it was given while held', () => {
    render(<TrafficChart runs={asRuns(run(60_000))} frozen />);

    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });
});

// Found by review, with a repro: every message on a topic carries some fields and only the
// newest carry others, so picking one of the rarer fields takes the run down to what carries it.
// A reading opened at an index past the end of that shorter run was read for its value without
// asking, and the pane — and the console around it — went white.
describe('a run that gets shorter under an opened reading', () => {
  let id = 0;
  const mixed = (): LogEntry[] =>
    Array.from({ length: 30 }, (_, i) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(Date.parse('2026-08-21T00:00:00Z') - i * 1000),
      topic: 'sensors/env',
      // Every message carries `a`; only the newest three carry `b`.
      body: i < 3 ? JSON.stringify({ a: 20 + i, b: 5 + i }) : JSON.stringify({ a: 20 + i }),
    }));

  it('closes the reading rather than taking the pane down with it', async () => {
    render(<TrafficChart runs={asRuns(mixed())} />);

    screen.getByTestId('plotArea').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('detail')).toBeInTheDocument();

    // From the keyboard, and that is the whole point of the gesture. A press outside the plot now
    // shuts the card on its own, so a *clicked* chip would take the card away before the run ever
    // got shorter — and this test would pass without going near the guard it was written for.
    screen.getByRole('button', { name: 'Chart b' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByTestId('plot')).toBeInTheDocument();
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });
});

/**
 * A device that reports its whole configuration in one message.
 *
 * The complaint this answers: forty chips reading `broker.session.expiryInterval` are the chart
 * region full of somebody else's field names, with the chart itself pushed off the bottom of it.
 */
describe('a body with its numbers nested', () => {
  let id = 0;
  const nested = (): LogEntry[] =>
    Array.from({ length: 20 }, (_, i) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(Date.parse('2026-08-21T00:00:00Z') - i * 1000),
      topic: 'devices/gateway',
      body: JSON.stringify({
        uptime: 900 + i,
        broker: { port: 1883, session: { expiryInterval: 3600 + i } },
      }),
    }));

  it('offers the top of the body rather than every path in it', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    expect(screen.getByRole('button', { name: 'Chart uptime' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open broker' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Chart broker.session.expiryInterval' }),
    ).not.toBeInTheDocument();
  });

  it('opens a group onto what is under it, and comes back out again', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open broker' }));

    expect(screen.getByRole('button', { name: 'Chart broker.port' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open broker.session' })).toBeInTheDocument();
    // The way in is gone while you are in it, and the way out names where you are standing.
    expect(screen.queryByRole('button', { name: 'Chart uptime' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back out of broker' }));

    expect(screen.getByRole('button', { name: 'Chart uptime' })).toBeInTheDocument();
  });

  it('walks down as far as the fields go', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open broker' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open broker.session' }));

    expect(
      screen.getByRole('button', { name: 'Chart broker.session.expiryInterval' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back out of broker.session' })).toBeInTheDocument();
  });

  /*
   * A field name is the message author's, and some of them are sentences: one chip reading
   * `expiryIntervalSeconds` is a chip about as wide as the plot under it, and a row of those is
   * the shift the walk was written to stop, arriving one level down instead of at the top.
   *
   * So the chip says as much of the name as it holds and two dots for the rest. What it is
   * remains the whole name: that is what a screen reader is handed, and what the title says.
   */
  it('cuts a name too long for a chip, and keeps the whole of it underneath', async () => {
    const long = (): LogEntry[] =>
      Array.from({ length: 20 }, (_, i) => ({
        id: id++,
        kind: 'recv' as const,
        at: new Date(Date.parse('2026-08-21T00:00:00Z') - i * 1000),
        topic: 'devices/gateway',
        body: JSON.stringify({ uptime: 900 + i, expiryIntervalSeconds: 3600 + i }),
      }));

    render(<TrafficChart runs={asRuns(long())} />);

    const chip = screen.getByRole('button', { name: 'Chart expiryIntervalSeconds' });

    expect(chip).toHaveTextContent('expiryInterval..');
    expect(chip).toHaveAttribute('title', 'expiryIntervalSeconds');
    // A name that fits is left alone, and carries no title to repeat what it already says.
    expect(screen.getByRole('button', { name: 'Chart uptime' })).not.toHaveAttribute('title');
  });

  // The chips are a way in rather than a reading, and a way in that stays open has become
  // furniture. What is left behind names what is charted, so nothing the row said is lost.
  it('puts the chips away, and keeps the one that says what is drawn', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Chart uptime' }));
    await userEvent.click(screen.getByRole('button', { name: 'Put the field chips away' }));

    expect(screen.queryByRole('button', { name: 'Open broker' })).not.toBeInTheDocument();
    // A label rather than a control: the way back is the mark beside it, and the word 'hide'
    // standing at the end of a row of field names read as one more field.
    expect(screen.getByTestId('chart')).toHaveTextContent('uptime');
    const back = screen.getByRole('button', { name: 'Show the field chips' });
    expect(back).toHaveTextContent('');

    await userEvent.click(back);

    expect(screen.getByRole('button', { name: 'Open broker' })).toBeInTheDocument();
  });
});

/**
 * The measurement follows the chart, which is not one element.
 *
 * The figure that says there is nothing to draw, the figure that holds a branch's small multiples
 * and the single chart's own are three different nodes, and the chart swaps between them under
 * its own feet — one message is 'too few' and two are a line. Measured once at mount, the
 * observer was left holding a node no longer in the document, a node with no box measures 0, and
 * the chart decided it had no room and never looked again. Thrown open it stayed a bare picture;
 * pinning it into a window was the only way to get the readings back, because a window mounts a
 * chart from scratch. That is what was reported.
 */
describe('a chart that changes what it is drawing', () => {
  let id = 0;
  const short = (count: number): LogEntry[] =>
    Array.from({ length: count }, (_, i) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(Date.now() - i * 1000),
      topic: 'sensors/temp',
      body: `${21 + (i % 3)}`,
    }));

  // Each figure answers with its own height, which is the whole point: the void figure is the
  // short one, and the chart that replaces it has been given room.
  const measured = () =>
    vi.stubGlobal(
      'ResizeObserver',
      class {
        ran: ResizeObserverCallback;

        constructor(ran: ResizeObserverCallback) {
          this.ran = ran;
        }

        observe(target: Element) {
          const height = (target as HTMLElement).dataset.detail === 'void' ? 180 : 600;

          this.ran([{ contentRect: { width: 420, height } } as ResizeObserverEntry], this as never);
        }

        unobserve() {}
        disconnect() {}
      },
    );

  afterEach(() => vi.unstubAllGlobals());

  it('measures the figure it is drawing now, not the one it drew at mount', () => {
    measured();
    const { rerender } = render(<TrafficChart runs={asRuns(short(1))} />);

    // One message is not a line, so this is the void figure, and it is a short one.
    expect(screen.getByTestId('chart')).toHaveAttribute('data-detail', 'void');
    expect(screen.queryByTestId('note')).not.toBeInTheDocument();

    rerender(<TrafficChart runs={asRuns(short(20))} />);

    expect(screen.getByTestId('chart')).toHaveAttribute('data-detail', 'full');
    expect(screen.getByTestId('note')).toBeInTheDocument();
  });
});

/**
 * The chart in a region too short to hold anything but the picture.
 *
 * In its column the chart is a glance, and everything the region carries is worth having — which
 * is the problem: the row of chips, the readings and csv together leave the line itself forty
 * pixels to happen in, and the line is the one thing here that cannot be read any other way. So
 * a small region draws the picture and the way to choose what is in it, and the rest is what the
 * chart thrown open is for.
 */
describe('a region with no room for more than the picture', () => {
  // jsdom lays nothing out, so the region has to be told how tall it is.
  const tall = (px: number) =>
    vi.stubGlobal(
      'ResizeObserver',
      class {
        ran: ResizeObserverCallback;

        constructor(ran: ResizeObserverCallback) {
          this.ran = ran;
        }

        observe() {
          this.ran(
            [{ contentRect: { width: 420, height: px } } as ResizeObserverEntry],
            this as never,
          );
        }

        unobserve() {}
        disconnect() {}
      },
    );

  afterEach(() => vi.unstubAllGlobals());

  const nested = (): LogEntry[] =>
    Array.from({ length: 20 }, (_, i) => ({
      id: nextId++,
      kind: 'recv' as const,
      at: new Date(Date.now() - i * 1000),
      topic: 'devices/gateway',
      body: JSON.stringify({ uptime: 900 + i, probe: { celsius: 21 + (i % 3) } }),
    }));

  it('draws the picture, and keeps the way to choose what is in it', () => {
    tall(200);
    render(<TrafficChart runs={asRuns(nested())} />);

    expect(screen.getByTestId('plot')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Field to chart' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open probe' })).toBeInTheDocument();
  });

  // Every one of these is a way of reading the run rather than the run: they belong with the
  // readings, and they leave with them.
  it('leaves the readings, the range, the view and csv to the chart thrown open', () => {
    tall(200);
    render(<TrafficChart runs={asRuns(nested())} />);

    expect(screen.queryByTestId('note')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Range to draw' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Distribution' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save the readings/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('chart')).toHaveAttribute('data-detail', 'plain');
  });

  // A size, not a place: the same component is the column, a window pinned off it and the chart
  // thrown open, and what decides this is how much room it has been given.
  it('draws all of it again once the region is tall enough', () => {
    tall(600);
    render(<TrafficChart runs={asRuns(nested())} />);

    expect(screen.getByTestId('note')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Range to draw' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Distribution' })).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toHaveAttribute('data-detail', 'full');
  });
});

/**
 * A row of chips wider than the pane it is in.
 *
 * It scrolls rather than wraps, because a second line of chips is the plot moving under the hand
 * that is walking the list — and a hidden scrollbar over chips that run off the edge is a row
 * that says nothing about the six names it is not showing. So each end that has more behind it
 * carries a count, and the control that puts the whole row away stands outside the scrolling part
 * where the fade can never reach it.
 */
describe('a chip row wider than the pane', () => {
  let id = 0;
  const wide = (): LogEntry[] =>
    Array.from({ length: 20 }, (_, i) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(Date.now() - i * 1000),
      topic: 'devices/gateway',
      body: JSON.stringify({
        uptime: 900 + i,
        gateway: { celsius: 21 + (i % 3) },
        broker: { port: 1883 },
        network: { rssi: -42 - (i % 5) },
        radios: { channel: 11 },
        sensors: { flow: 3 + (i % 7) },
        counters: { published: 1200 + i },
      }),
    }));

  /**
   * jsdom lays nothing out, so the strip and its chips are given the geometry a narrow pane would
   * give them: a strip `across` wide, and chips of `step` laid end to end from its left edge,
   * moved along by whatever the strip has been scrolled to.
   */
  function laidOut(across: number, step: number) {
    const own = Element.prototype.getBoundingClientRect;

    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'field-strip' ? across : 0;
      },
    });

    Element.prototype.getBoundingClientRect = function () {
      const el = this as HTMLElement;
      if (el.dataset.testid === 'field-strip') return { left: 0, right: across } as DOMRect;

      const strip = el.parentElement;
      if (strip?.dataset.testid !== 'field-strip') return own.call(this);

      const index = [...strip.children].indexOf(el);
      const at = index * step - strip.scrollLeft;

      return { left: at, right: at + step } as DOMRect;
    };

    return () => {
      Element.prototype.getBoundingClientRect = own;
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    };
  }

  it('says how many chips are off the end of it', () => {
    // Six chips of sixty in a strip two hundred wide: three are on screen, three are not.
    const done = laidOut(200, 60);
    render(<TrafficChart runs={asRuns(wide())} />);

    expect(screen.getByRole('button', { name: '3 more along the row' })).toBeInTheDocument();
    expect(screen.getByTestId('field-strip')).toHaveAttribute('data-more', 'end');
    done();
  });

  it('says nothing while the whole row is on screen', () => {
    const done = laidOut(900, 60);
    render(<TrafficChart runs={asRuns(wide())} />);

    expect(screen.queryByRole('button', { name: /more along the row/ })).not.toBeInTheDocument();
    // No fade either, which is what was eating the control at the end of the row.
    expect(screen.getByTestId('field-strip')).not.toHaveAttribute('data-more');
    done();
  });

  it('says what is behind once the row has been scrolled', () => {
    const done = laidOut(200, 60);
    render(<TrafficChart runs={asRuns(wide())} />);

    const strip = screen.getByTestId('field-strip');
    strip.scrollLeft = 120;
    fireEvent.scroll(strip);

    expect(screen.getByRole('button', { name: '2 more, back along the row' })).toBeInTheDocument();
    expect(strip).toHaveAttribute('data-more', 'start end');
    done();
  });

  // The reported fault: the control that puts the chips away had its right-hand side cut off. It
  // was inside the scroller, where an auto margin cannot hold anything at the end of a box whose
  // free space is negative — so it sat past the last chip — and the fade painted on the scroller's
  // edge took a bite out of whatever was under it.
  it('keeps the control that puts the row away out of the scrolling part', () => {
    const done = laidOut(200, 60);
    render(<TrafficChart runs={asRuns(wide())} />);

    const away = screen.getByRole('button', { name: 'Put the field chips away' });
    expect(screen.getByTestId('field-strip')).not.toContainElement(away);
    expect(screen.getByRole('group', { name: 'Field to chart' })).toContainElement(away);
    done();
  });

  it('steps onto the chips rather than by a fixed distance', () => {
    const done = laidOut(200, 60);
    render(<TrafficChart runs={asRuns(wide())} />);

    const strip = screen.getByTestId('field-strip');
    strip.scrollBy = vi.fn();

    fireEvent.click(screen.getByRole('button', { name: '3 more along the row' }));

    // The first chip wholly out of sight starts at 240; brought to the left edge less the fade.
    expect(strip.scrollBy).toHaveBeenCalledWith({ left: 240 - 16, behavior: 'smooth' });
    done();
  });
});
