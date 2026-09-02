import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderWithClient } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { AutoReconnectSwitch } from './AutoReconnectSwitch';

/**
 * The standing answer, and the one control in this feature that is not about a particular outage.
 *
 * It has two homes in one panel — under the form, and inside the reconnect block on an outage —
 * which is exactly why it is its own component and why its test is here rather than in either of
 * theirs: one mutation, one source of truth about what the option currently is.
 */
describe('the auto-reconnect switch', () => {
  const status = (over: Record<string, unknown> = {}) =>
    server.use(
      http.get('/api/connection/reconnect', () =>
        HttpResponse.json({
          enabled: true,
          active: false,
          attempt: 0,
          nextAttemptAt: null,
          gaveUp: false,
          now: '2026-09-02T21:00:00.000Z',
          ...over,
        }),
      ),
    );

  const box = () => screen.findByRole('checkbox', { name: /Reconnect automatically/ });

  it('shows the option the server is holding', async () => {
    status({ enabled: false });

    renderWithClient(<AutoReconnectSwitch id="a" />);

    await waitFor(async () => expect(await box()).not.toBeChecked());
  });

  it('sends the answer the reader gave', async () => {
    status();
    let sent: unknown;
    server.use(
      http.put('/api/connection/reconnect', async ({ request }) => {
        sent = await request.json();

        return HttpResponse.json({
          enabled: false,
          active: false,
          attempt: 0,
          nextAttemptAt: null,
          gaveUp: false,
          now: '2026-09-02T21:00:00.000Z',
        });
      }),
    );

    renderWithClient(<AutoReconnectSwitch id="a" />);
    await userEvent.click(await box());

    await waitFor(() => expect(sent).toEqual({ enabled: false }));
  });

  // Written from the answer rather than invalidated and re-fetched, so there is no round trip
  // between the click and the switch moving. The handler above still says enabled, so a refetch
  // would put the tick straight back.
  it('moves off the answer alone, without asking again', async () => {
    status();
    server.use(
      http.put('/api/connection/reconnect', () =>
        HttpResponse.json({
          enabled: false,
          active: false,
          attempt: 0,
          nextAttemptAt: null,
          gaveUp: false,
          now: '2026-09-02T21:00:00.000Z',
        }),
      ),
    );

    renderWithClient(<AutoReconnectSwitch id="a" />);
    await userEvent.click(await box());

    await waitFor(async () => expect(await box()).not.toBeChecked());
  });

  // The id is passed in because this component has two homes in one panel, and two checkboxes
  // sharing an id is a label that points at whichever the browser found first.
  it('wears the id it was given', async () => {
    status();

    renderWithClient(<AutoReconnectSwitch id="somewhere-particular" />);

    expect(await box()).toHaveAttribute('id', 'somewhere-particular');
  });
});
