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

afterEach(() => {
  vi.unstubAllGlobals();
});

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

/** A drag is a grab, a move and a release; the move only lands on the next animation frame. */
async function drag(seam: HTMLElement, to: number) {
  fireEvent.pointerDown(seam, { pointerId: 1, clientY: 0, clientX: 0 });
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
    const seen: Element[] = [];
    let report: ((entries: ResizeObserverEntry[]) => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(ran: (entries: ResizeObserverEntry[]) => void) {
          report = ran;
        }
        observe(target: Element) {
          seen.push(target);
          report?.([{ target, contentRect: { height: 60 } } as unknown as ResizeObserverEntry]);
        }
        unobserve() {}
        disconnect() {}
      },
    );

    // jsdom lays nothing out, and a column of no height has no split to work out.
    const sized = (name: 'clientHeight' | 'scrollHeight', px: number) =>
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: px });
    sized('clientHeight', 800);
    sized('scrollHeight', 120);

    render(<Workspace {...parts} />);

    // Mounted, and told its own size — still content-fit, nothing fixed.
    expect(seen).toHaveLength(1);
    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');

    // The first message lands and the log grows.
    act(() =>
      report?.([{ target: seen[0], contentRect: { height: 185 } } as unknown as ResizeObserverEntry]),
    );

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'split');

    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
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
    await drag(seam, 830);

    // The pair is the two boxes themselves — 630 of chart and 167 of form — and not the 800 from
    // one end to the other, which counted the seam between them as if it belonged to somebody.
    // The pointer is at the chart's own bottom edge, so the chart takes all 630 of the 797.
    expect(column.style.gridTemplateRows).toContain('minmax(0, 79.05fr)');
    expect(column.style.gridTemplateRows).toContain('minmax(0, 20.95fr)');
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
