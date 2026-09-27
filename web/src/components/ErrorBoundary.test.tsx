import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('render exploded');
}

// Silences React's console.error for the caught error.
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary', () => {
  it('shows the failure instead of a blank page', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('render exploded')).toBeInTheDocument();
  });

  it('shows what the part it stands around says instead, when it is told', () => {
    render(
      <ErrorBoundary fallback={(error) => <p>Could not draw this: {error.message}</p>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Could not draw this: render exploded')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).not.toBeInTheDocument();
  });

  it('leaves a healthy tree alone', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('all good')).toBeInTheDocument();
  });
});
