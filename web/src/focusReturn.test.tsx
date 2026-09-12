import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';
import { PANELS } from './features/panels';

/**
 * Where the keyboard goes when a panel is shut.
 *
 * A panel's × unmounts the button that was just pressed, and a browser hands focus to the body
 * when that happens. Nothing put it back, so the next Tab restarted from the first control in the
 * document: a reader who opened Settings — the last row in the rail — and closed it again was
 * returned to the top of the console and had to walk the whole rail to reach where they had been.
 * All eight panels did it.
 *
 * The rule is the ordinary one for anything that opens and shuts: the thing that opened it is
 * where the reader comes back to.
 */
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

const railRow = (label: string) =>
  within(screen.getByRole('navigation', { name: 'Panels' })).getByRole('button', {
    name: new RegExp(`^${label}`),
  });

describe('shutting a panel puts the reader back on the row that opened it', () => {
  it.each(PANELS.map((panel) => panel.label))('holds for %s', async (label) => {
    await openConsole();

    if (screen.queryByRole('region', { name: `${label} panel` }) === null) {
      await userEvent.click(railRow(label));
    }
    await screen.findByRole('region', { name: `${label} panel` });

    await userEvent.click(screen.getByRole('button', { name: `Close ${label} panel` }));

    await waitFor(() => expect(document.activeElement).toBe(railRow(label)));
  });

  // The rail's own row toggles, and a reader who shuts a panel that way never lost focus — the
  // button they pressed is still there. Pinned so the fix above cannot quietly move it.
  it('leaves focus on the row when the row is what shut the panel', async () => {
    await openConsole();

    await userEvent.click(railRow('Broker'));

    expect(screen.queryByRole('region', { name: 'Broker panel' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(railRow('Broker'));
  });
});
