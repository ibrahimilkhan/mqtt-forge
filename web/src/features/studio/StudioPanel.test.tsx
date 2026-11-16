import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chunk = { arrives: false };

/** As FlowsPanel's test: a chunk that does not arrive, or arrives and fails while it draws. */
async function freshPanel() {
  vi.resetModules();
  vi.doMock('./StudioPage', () => {
    if (!chunk.arrives) throw new TypeError('error loading dynamically imported module: /assets/StudioPage-x1.js');
    return {
      default: function StudioPage(): never {
        throw new Error('The view lost its scene.');
      },
    };
  });
  return (await import('./StudioPanel')).StudioPanel;
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('3D Studio panel', () => {
  it('says the studio could not be loaded, and offers a reload', async () => {
    chunk.arrives = false;
    const StudioPanel = await freshPanel();
    render(<StudioPanel onClose={() => {}} />);

    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the console' })).toBeInTheDocument();
  });

  it('says what went wrong when the studio fails while drawing', async () => {
    chunk.arrives = true;
    const StudioPanel = await freshPanel();
    render(<StudioPanel onClose={() => {}} />);

    expect(await screen.findByText(/The view lost its scene/)).toBeInTheDocument();
  });

  it('is a named region with a close button', async () => {
    chunk.arrives = true;
    const StudioPanel = await freshPanel();
    render(<StudioPanel onClose={() => {}} />);

    expect(screen.getByRole('region', { name: '3D Studio panel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close 3D Studio panel' })).toBeInTheDocument();
  });
});
