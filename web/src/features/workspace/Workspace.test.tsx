import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitRows, Workspace } from './Workspace';
import { MIN_SHARE } from './ResizeHandle';

const parts = {
  tree: <div>tree pane</div>,
  log: <div>log pane</div>,
  chart: <div>chart pane</div>,
  publish: <div>publish pane</div>,
};

describe('fitRows', () => {
  it('leaves the log and the publish pane exactly the heights their content needs', () => {
    const rows = fitRows(1000, 200, 300)!;

    expect(rows.log).toBeCloseTo(0.2);
    expect(rows.publish).toBeCloseTo(0.3);
  });

  // The entries are one row until asked for more and the form is the size the form is; a line
  // has no natural height at all, so the room left over is the chart's.
  it('hands the chart what the two ends do not need', () => {
    const rows = fitRows(1000, 200, 300)!;

    expect(rows.chart).toBeCloseTo(0.5);
    expect(rows.log + rows.chart + rows.publish).toBeCloseTo(1);
  });

  // The two ends keep the height their content asks for whatever the window does, so a taller
  // window is height the chart gets all of.
  it('gives the chart more of the column as the window grows', () => {
    expect(fitRows(1000, 400, 300)!.chart).toBeCloseTo(0.3);
    expect(fitRows(2000, 400, 300)!.chart).toBeCloseTo(0.65);
  });

  // Otherwise a tall form on a short window would leave no chart at all.
  it('never starves a region below the drag floor', () => {
    const rows = fitRows(400, 20, 390)!;

    expect(rows.log).toBe(MIN_SHARE);
    expect(rows.chart).toBeGreaterThanOrEqual(MIN_SHARE);
    expect(rows.publish).toBeCloseTo(1 - 2 * MIN_SHARE);
  });

  it('never lets the entries take the room the other two need', () => {
    const rows = fitRows(400, 4000, 40)!;

    expect(rows.log).toBeCloseTo(1 - 2 * MIN_SHARE);
    expect(rows.chart).toBe(MIN_SHARE);
    expect(rows.publish).toBe(MIN_SHARE);
  });

  // An unmeasured layout reports zero; there is nothing to divide yet.
  it('declines to answer before the column has been laid out', () => {
    expect(fitRows(0, 200, 320)).toBeNull();
  });
});

// jsdom lays nothing out, so a test that needs a height stubs one onto the prototype. Cleared
// here rather than at the end of the test that set it: a test that fails before its own cleanup
// used to leave the stub standing, and the next test measured against it.
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ['clientHeight', 'scrollHeight']) Reflect.deleteProperty(HTMLElement.prototype, name);
});

const sized = (name: 'clientHeight' | 'scrollHeight', px: number) =>
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: px });

/** A ResizeObserver that hands back the report function, so a test can drive it. */
function observing() {
  const seen: Element[] = [];
  const box = { report: null as ((entries: ResizeObserverEntry[]) => void) | null, seen };

  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(ran: (entries: ResizeObserverEntry[]) => void) {
        box.report = ran;
      }
      observe(target: Element) {
        seen.push(target);
        box.report?.([{ target, contentRect: { height: 60 } } as unknown as ResizeObserverEntry]);
      }
      unobserve() {}
      disconnect() {}
    },
  );

  return {
    ...box,
    grows: (height: number) =>
      act(() =>
        box.report?.([
          { target: seen[0], contentRect: { height } } as unknown as ResizeObserverEntry,
        ]),
      ),
  };
}

// jsdom lays nothing out and knows nothing about pointer capture, so a drag has to be given
// both: the rects the column would really have, and a capture that says the bar is holding the
// pointer. Only the near pane's leading edge and the far pane's trailing edge are read.
function laidOut(element: Element, top: number, bottom: number) {
  element.getBoundingClientRect = () =>
    ({ top, bottom, left: top, right: bottom, height: bottom - top, width: bottom - top }) as DOMRect;
}

function capturing() {
  const held = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
  };
  for (const [name, value] of Object.entries(held)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }

  return () => {
    for (const name of Object.keys(held)) Reflect.deleteProperty(HTMLElement.prototype, name);
  };
}

/**
 * A drag is a grab, a move and a release; the move only lands on the next animation frame.
 *
 * Where it was grabbed matters as much as where it was let go: the handle keeps the distance
 * between the hand and the boundary for the whole drag, so a grab has to be somewhere a hand
 * could really have landed.
 */
async function drag(seam: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(seam, { pointerId: 1, clientY: from, clientX: from });
  fireEvent.pointerMove(seam, { pointerId: 1, clientY: to, clientX: to });
  await act(() => new Promise((frame) => requestAnimationFrame(() => frame(undefined))));
  fireEvent.pointerUp(seam, { pointerId: 1 });
}

describe('Workspace', () => {
  // jsdom reports no heights, so the column stays in the mode it opens in — which is the
  // mode that matters: the two ends take what they need and the chart gets the rest.
  it('opens with the log and the publish pane sized to their own content', () => {
    render(<Workspace {...parts} />);

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');
  });

  it('shows every pane it was given', () => {
    render(<Workspace {...parts} panel={<div>panel pane</div>} />);

    for (const text of ['panel pane', 'tree pane', 'log pane', 'chart pane', 'publish pane']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  // Three fixed places down the right column, in the order they are read. Each wears the strip
  // that folds it, so the region's text is its own name and then its pane.
  it('stacks the log, the chart and publish in that order', () => {
    render(<Workspace {...parts} />);

    const column = screen.getByTestId('right-column');
    const panes = [...column.children].map((child) => child.getAttribute('data-region') ?? '');

    expect(panes).toEqual(['log', '', 'chart', '', 'publish']);
  });

  // The share used to be taken at mount, when the log is still showing the sentence asking the
  // reader to pick a topic. The message that replaced it did not fit, and the count of what was
  // behind it fell off the bottom of the region.
  it('waits for the log to have something in it before fixing the split', () => {
    const watch = observing();
    sized('clientHeight', 800);
    sized('scrollHeight', 120);

    render(<Workspace {...parts} log={<div data-resting="">one message</div>} />);

    // Mounted, and told its own size — still content-fit, nothing fixed.
    expect(watch.seen).toHaveLength(1);
    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');
  });

  // The complaint: the region was cut to the size of the FIRST message that ever landed in it, so
  // a short reading followed by a payload six lines deep left the reader scrolling a region
  // shaped for a number. Content-fit means the log's track is min-content, which is already the
  // right answer for every message — it only had to be allowed to go on being the answer.
  it('follows the message while the log is showing one, however tall it grows', () => {
    const watch = observing();
    sized('clientHeight', 800);
    sized('scrollHeight', 120);

    render(<Workspace {...parts} log={<div data-resting="">one message</div>} />);

    watch.grows(185);
    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');

    // A much taller message on the same topic, and the column still has not been divided.
    watch.grows(320);
    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');
  });

  // Opening the history is a request for more rows than any region could hold, and the pane's own
  // 'N more below' is the answer to that rather than a taller region. So that is where the
  // following stops — and it stops at the height the log stood at while it was resting, not at
  // the height of the opened list.
  it('fixes the split when the reader opens the history, at the resting height', () => {
    const watch = observing();
    sized('clientHeight', 800);
    sized('scrollHeight', 120);

    const { rerender } = render(<Workspace {...parts} log={<div data-resting="">one message</div>} />);
    watch.grows(320);

    // The list is no longer resting, and the region grew past what it stood at.
    rerender(<Workspace {...parts} log={<div>twenty-five rows</div>} />);
    watch.grows(700);

    const column = screen.getByTestId('right-column');
    expect(column).toHaveAttribute('data-fit', 'split');
    // 320 of 800 is the message it was following, not the 700 the opened list asked for.
    expect(column.style.gridTemplateRows).toContain('minmax(0, 40.00fr)');
  });

  // A quieter topic, a fault, a sentence: the log gets shorter and the column simply follows it
  // down. Nothing to divide the column around.
  it('follows the log back down without fixing anything', () => {
    const watch = observing();
    sized('clientHeight', 800);
    sized('scrollHeight', 120);

    render(<Workspace {...parts} log={<div data-resting="">one message</div>} />);

    watch.grows(320);
    watch.grows(90);

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');
  });

  it('folds a region away to its own strip, and brings it back', async () => {
    render(<Workspace {...parts} />);

    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));

    expect(screen.queryByText('chart pane')).not.toBeInTheDocument();
    expect(screen.getByText('log pane')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open Chart' }));

    expect(screen.getByText('chart pane')).toBeInTheDocument();
  });

  // A column of three shut strips is a column with nothing in it, and nothing else in the
  // workspace would say what to do about that.
  it('will not fold the last region left open', async () => {
    render(<Workspace {...parts} />);

    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fold Publish' }));

    expect(screen.getByRole('button', { name: 'Log — the last region open' })).toBeDisabled();
    expect(screen.getByText('log pane')).toBeInTheDocument();
  });

  // The complaint this is about: fold the chart and neither seam answered any more, so the log
  // could not be shortened and the form could not be lengthened. A folded region is a header and
  // nothing else, so what the seams either side of it divide is whatever lies beyond it — which
  // is the log and the form, and a reader grabbing either edge of that strip means exactly that.
  it('keeps both seams live when the region between them is folded away', async () => {
    render(<Workspace {...parts} />);

    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));

    expect(screen.getByRole('separator', { name: 'Log and chart boundary' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('separator', { name: 'Chart and publish boundary' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('moves the log against the form when the chart is folded between them', async () => {
    render(<Workspace {...parts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));

    const seam = screen.getByRole('separator', { name: 'Log and chart boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowUp}');

    // Three tenths of the column each, so the pair is six tenths and the seam starts halfway; a
    // step of two per cent of the pair puts the log at 48 of it and gives the form the rest. The
    // chart's own share is untouched, waiting for it to be opened again.
    const column = screen.getByTestId('right-column');
    expect(column.style.gridTemplateRows).toContain('minmax(0, 48.00fr)');
    expect(column.style.gridTemplateRows).toContain('minmax(0, 52.00fr)');
  });

  // A seam with nothing beyond it on one side would move something the reader cannot see.
  it('takes a seam with nothing beyond it out of reach', async () => {
    render(<Workspace {...parts} />);

    await userEvent.click(screen.getByRole('button', { name: 'Fold Log' }));

    // By label rather than by role: a seam with nothing to divide is aria-hidden, so the role is
    // gone from the tree along with it — which is the other half of what 'out of reach' means.
    expect(
      screen.getByLabelText('Log and chart boundary', { selector: '[role=separator]' }),
    ).toHaveAttribute('tabindex', '-1');
    // And the one below it still divides the two that are open.
    expect(screen.getByRole('separator', { name: 'Chart and publish boundary' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  // The complaint this is about: fold a region away and the seams below it stopped answering the
  // pointer. They were measured against the whole column, and a folded region does not take a
  // share of it — it takes a header and gives up the rest — so the boundary landed wherever that
  // arithmetic said rather than under the reader's hand.
  it('puts the seam under the pointer with a region folded away above it', async () => {
    const done = capturing();
    render(<Workspace {...parts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fold Log' }));

    const column = screen.getByTestId('right-column');
    const [, , chartRegion, , publishRegion] = [...column.children];
    // The column is laid out too, so the old arithmetic has everything it wanted and the test
    // turns on which box the seam measures against rather than on a missing rect.
    laidOut(column, 0, 1000);
    // A tall folded strip, so the two answers are far enough apart to tell apart.
    laidOut(chartRegion, 200, 830);
    laidOut(publishRegion, 833, 1000);

    const seam = screen.getByRole('separator', { name: 'Chart and publish boundary' });
    // Grabbed on the bar itself, a pixel past the chart's edge, and taken up to 700.
    await drag(seam, 831, 700);

    // The boundary travels 797 — the 800 from one end to the other, less the 3 the bar between
    // them takes with it — and the hand keeps the pixel it grabbed at, so it lands at 499 of 797.
    expect(column.style.gridTemplateRows).toContain('minmax(0, 62.61fr)');
    expect(column.style.gridTemplateRows).toContain('minmax(0, 37.39fr)');
    done();
  });

  // The blink. The mapping was exact where the panes are and flat everywhere between them — and
  // with a folded region beside it, the gap between the panes is thirty pixels, which is where
  // the pointer spends the whole drag. A step of the pointer moved the boundary, and moving the
  // boundary moved the flat band back under the pointer.
  it('goes on answering the pointer between two panes with a strip between them', async () => {
    const done = capturing();
    render(<Workspace {...parts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));

    const column = screen.getByTestId('right-column');
    const [logRegion, , chartStrip, , publishRegion] = [...column.children];
    laidOut(column, 0, 1000);
    laidOut(logRegion, 0, 500);
    // The folded strip, with a bar either side of it: thirty pixels belonging to neither pane.
    laidOut(chartStrip, 503, 529);
    laidOut(publishRegion, 532, 1000);

    const seam = screen.getByRole('separator', { name: 'Log and chart boundary' });

    // 514 of the 968 the boundary can travel.
    await drag(seam, 501, 515);
    expect(column.style.gridTemplateRows).toContain('minmax(0, 53.10fr)');

    // Ten pixels further down, still inside that gap, and it answers ten pixels further down.
    await drag(seam, 501, 525);
    expect(column.style.gridTemplateRows).toContain('minmax(0, 54.13fr)');
    done();
  });

  it('gives each boundary in the column a handle of its own', () => {
    render(<Workspace {...parts} />);

    expect(screen.getByRole('separator', { name: 'Log and chart boundary' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Chart and publish boundary' })).toBeInTheDocument();
  });

  it('drops the panel column when no panel is open', () => {
    render(<Workspace {...parts} />);

    expect(screen.getByTestId('layout')).toHaveAttribute('data-panel', 'closed');
    expect(screen.queryByLabelText('Panel and topics boundary')).not.toBeInTheDocument();
  });
});

/**
 * Double-clicking a boundary sizes the region it names to exactly what is inside it.
 *
 * jsdom lays nothing out, so what the measurement itself would answer cannot be asked here — the
 * probe is a grid template written, a height read and the template put back, and every one of
 * those reads is zero. What these do instead is give the two regions a height each and check the
 * arithmetic on top of it: which region a seam names, which pair it divides that region against,
 * whether it goes through the same floor a drag does, and when it declines to answer at all.
 */
describe('fitting a region to its contents', () => {
  /** The height a region is standing at, on the one element rather than on every element. */
  const standing = (region: Element, px: number) =>
    Object.defineProperty(region, 'offsetHeight', { configurable: true, value: px });

  /**
   * The fit lands on the next frame, like a drag — it goes through the same throttle.
   *
   * `detail` is what says a double-click happened: a click carries the number of presses in the
   * run it belongs to, so the second is 2 and the fourth is 4.
   */
  async function press(seam: HTMLElement, presses: number) {
    fireEvent.click(seam, { detail: presses });
    await act(() => new Promise((frame) => requestAnimationFrame(() => frame(undefined))));
  }

  /**
   * A column the reader owns, with the three regions standing at heights of the test's choosing.
   *
   * Folded and opened again rather than dragged: both write a split, and this one writes the
   * stand-in fractions exactly — three tenths, four tenths, three tenths — which is a column the
   * arithmetic below can be read against by hand.
   */
  async function arranged(log: number, chart: number, publish: number) {
    render(<Workspace {...parts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open Chart' }));

    const column = screen.getByTestId('right-column');
    const [logRegion, , chartRegion, , publishRegion] = [...column.children];
    standing(logRegion, log);
    standing(chartRegion, chart);
    standing(publishRegion, publish);

    return { column, logRegion };
  }

  // The column already sizes both its ends to their contents until somebody arranges it, so there
  // is nothing here to fit — and writing a split down to say so would end the log's following of
  // its own message for good, which is the arrangement this gesture was asked to restore.
  it('leaves a column that is already sizing itself to its contents alone', async () => {
    render(<Workspace {...parts} />);

    await press(screen.getByRole('separator', { name: 'Log and chart boundary' }), 2);

    const column = screen.getByTestId('right-column');
    expect(column).toHaveAttribute('data-fit', 'content');
    expect(column.style.gridTemplateRows).toBe('');
  });

  it('sizes the log to its own height from the boundary under it', async () => {
    const { column } = await arranged(100, 400, 100);

    await press(screen.getByRole('separator', { name: 'Log and chart boundary' }), 2);

    // The log wants a hundred of the five hundred pixels it shares with the chart, and those two
    // stand in seven tenths of the column: fourteen hundredths for the log, the rest of the pair
    // to the chart. The form is not in that pair and does not move.
    expect(column.style.gridTemplateRows).toBe(
      'minmax(0, 14.00fr) auto minmax(0, 56.00fr) auto minmax(0, 30.00fr)',
    );
  });

  it('sizes the publish form to its own height from the boundary over it', async () => {
    const { column } = await arranged(100, 400, 100);

    await press(screen.getByRole('separator', { name: 'Chart and publish boundary' }), 2);

    expect(column.style.gridTemplateRows).toBe(
      'minmax(0, 30.00fr) auto minmax(0, 56.00fr) auto minmax(0, 14.00fr)',
    );
  });

  // A seam is named for its place in the column and fits the region in that place, not whichever
  // one happens to lie against it: fold the chart and both boundaries divide the log from the
  // form, but the one under the log still fits the log.
  it('fits the region it names with the one beside it folded away', async () => {
    render(<Workspace {...parts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));

    const column = screen.getByTestId('right-column');
    const [logRegion, , , , publishRegion] = [...column.children];
    standing(logRegion, 100);
    standing(publishRegion, 300);

    await press(screen.getByRole('separator', { name: 'Log and chart boundary' }), 2);

    // A quarter of the four hundred the two of them hold, and the chart keeps the share it will
    // stand in again when it is opened.
    expect(column.style.gridTemplateRows).toBe(
      'minmax(0, 25.00fr) auto min-content auto minmax(0, 75.00fr)',
    );
  });

  // The floor is a share of the column, and a folded region still holds its share in state while
  // giving up its place in the layout — so the pair either side of it was being told that a tenth
  // of the column is a fifth of them, and the log stopped well above the height it was asked for.
  it('lets a region reach its own height with another one folded away', async () => {
    render(<Workspace {...parts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fold Chart' }));

    const column = screen.getByTestId('right-column');
    const [logRegion, , , , publishRegion] = [...column.children];
    standing(logRegion, 60);
    standing(publishRegion, 340);

    await press(screen.getByRole('separator', { name: 'Log and chart boundary' }), 2);

    // Fifteen hundredths of the four hundred the two of them hold. The old floor would have
    // stopped it at a fifth, which is a third again taller than the log had anything to put in it.
    expect(column.style.gridTemplateRows).toBe(
      'minmax(0, 15.00fr) auto min-content auto minmax(0, 85.00fr)',
    );
  });

  it('does nothing on a single press', async () => {
    const { column } = await arranged(100, 400, 100);

    await press(screen.getByRole('separator', { name: 'Log and chart boundary' }), 1);

    expect(column.style.gridTemplateRows).toBe(
      'minmax(0, 30.00fr) auto minmax(0, 40.00fr) auto minmax(0, 30.00fr)',
    );
  });

  // `detail` counts the whole run of presses rather than starting over at each pair, so a reader
  // who wants it again after the pane has changed under them presses again and gets it.
  it('answers the fourth press as well as the second', async () => {
    const { column, logRegion } = await arranged(100, 400, 100);
    const seam = screen.getByRole('separator', { name: 'Log and chart boundary' });

    await press(seam, 2);
    standing(logRegion, 200);
    await press(seam, 4);

    // Two hundred of the six hundred the pair now stands at, of the seven tenths they divide.
    expect(column.style.gridTemplateRows).toBe(
      'minmax(0, 23.33fr) auto minmax(0, 46.67fr) auto minmax(0, 30.00fr)',
    );
  });

  // Nothing beyond it on one side, so there is no pair to divide and nothing to fit into it.
  it('declines on a boundary with nothing left to divide', async () => {
    render(<Workspace {...parts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fold Publish' }));

    const column = screen.getByTestId('right-column');
    const held = column.style.gridTemplateRows;

    // By label rather than by role: a seam with nothing to divide is aria-hidden.
    await press(
      screen.getByLabelText('Chart and publish boundary', { selector: '[role=separator]' }),
      2,
    );

    expect(column.style.gridTemplateRows).toBe(held);
  });

  // The two boundaries between the columns have no gesture at all. A width would have to snap to
  // the widest row the tree is holding, which is whichever topic arrived last.
  it('gives the boundaries between the columns nothing to fit', async () => {
    render(<Workspace {...parts} panel={<div>panel pane</div>} />);

    const layout = screen.getByTestId('layout');
    const held = layout.style.getPropertyValue('--tree');

    for (const name of ['Panel and topics boundary', 'Topics and log boundary']) {
      const seam = screen.getByRole('separator', { name });
      expect(seam).not.toHaveAttribute('title');
      await press(seam, 2);
    }

    expect(layout.style.getPropertyValue('--tree')).toBe(held);
  });

  it('says which region each boundary fits', () => {
    render(<Workspace {...parts} />);

    expect(screen.getByRole('separator', { name: 'Log and chart boundary' })).toHaveAttribute(
      'title',
      'Fit the log',
    );
    expect(screen.getByRole('separator', { name: 'Chart and publish boundary' })).toHaveAttribute(
      'title',
      'Fit the publish form',
    );
  });

  // The same gesture for a reader who is not holding a pointer. The fold that Enter sometimes
  // means on a splitter lives on the strip inside the region, which names what it shuts.
  it('fits from the keyboard as well', async () => {
    const { column } = await arranged(100, 400, 100);

    const seam = screen.getByRole('separator', { name: 'Log and chart boundary' });
    seam.focus();
    await userEvent.keyboard('{Enter}');
    await act(() => new Promise((frame) => requestAnimationFrame(() => frame(undefined))));

    expect(column.style.gridTemplateRows).toBe(
      'minmax(0, 14.00fr) auto minmax(0, 56.00fr) auto minmax(0, 30.00fr)',
    );
  });
});
