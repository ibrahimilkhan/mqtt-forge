import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  // Three fixed places down the right column, in the order they are read.
  it('stacks the log, the chart and publish in that order', () => {
    render(<Workspace {...parts} />);

    const column = screen.getByTestId('right-column');
    const panes = [...column.children].map((child) => child.textContent);

    expect(panes).toEqual(['log pane', '', 'chart pane', '', 'publish pane']);
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
