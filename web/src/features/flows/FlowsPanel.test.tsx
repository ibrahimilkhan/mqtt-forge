import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowsPanel } from './FlowsPanel';

// What a tab left open across an update meets: the page's chunk has a new name in the new build,
// and the one this tab asks for is gone.
vi.mock('./FlowsPage', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/FlowsPage-CaOaZmu6.js');
});

// React reports the error it caught, and the boundary logs it; neither is what this is about.
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('Flows panel', () => {
  it('says the page could not be loaded, and offers to reload the console', async () => {
    render(<FlowsPanel onClose={() => {}} />);

    expect(await screen.findByText(/The page could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the console' })).toBeInTheDocument();
    // Only the page failed. The panel around it still has its name and its way out.
    expect(screen.getByRole('heading', { name: 'Flows' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Flows panel' })).toBeInTheDocument();
  });
});
