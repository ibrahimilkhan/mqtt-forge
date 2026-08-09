import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fitShare, Workspace } from './Workspace';
import { MIN_SHARE } from './ResizeHandle';

const parts = {
  tree: <div>tree pane</div>,
  log: <div>log pane</div>,
  publish: <div>publish pane</div>,
};

describe('fitShare', () => {
  it('leaves the publish pane exactly the height its form needs', () => {
    expect(fitShare(800, 320)).toBeCloseTo(0.6);
  });

  it('gives the log more of the column as the window grows', () => {
    expect(fitShare(1600, 320)).toBeCloseTo(0.8);
  });

  // Otherwise a tall form on a short window would leave no log at all.
  it('never starves the log below the drag floor', () => {
    expect(fitShare(400, 390)).toBe(MIN_SHARE);
  });

  it('never hands the publish pane less than the drag floor either', () => {
    expect(fitShare(800, 10)).toBe(1 - MIN_SHARE);
  });

  // An unmeasured layout reports zero; there is nothing to divide yet.
  it('declines to answer before the column has been laid out', () => {
    expect(fitShare(0, 320)).toBeNull();
  });
});

describe('Workspace', () => {
  // jsdom reports no heights, so the column stays in the mode it opens in — which is the
  // mode that matters: publish takes what it needs and the log gets the rest.
  it('opens with the publish pane sized to its own content', () => {
    render(<Workspace {...parts} />);

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');
  });

  it('shows every pane it was given', () => {
    render(<Workspace {...parts} panel={<div>panel pane</div>} />);

    for (const text of ['panel pane', 'tree pane', 'log pane', 'publish pane']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('drops the panel column when no panel is open', () => {
    render(<Workspace {...parts} />);

    expect(screen.getByTestId('layout')).toHaveAttribute('data-panel', 'closed');
    expect(screen.queryByLabelText('Panel and topics boundary')).not.toBeInTheDocument();
  });
});
