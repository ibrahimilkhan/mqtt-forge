import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { createFakeHub } from '../../realtime/fakeHub';
import { resetLinkWatch } from '../../stores/linkWatchStore';
import { server } from '../../test/server';
import type { BrokerFailure, ConnectionState, ReconnectStatus } from '../../types/api';

/**
 * A link that drops out from under the reader, through the whole console.
 *
 * The other two files test the pieces: linkWatchStore is the transition table, ReconnectNotice is
 * the block. This one is about what the console *does* — which panel is open, and whether it
 * stays open — because that is the half of the requirement no unit test can see.
 */
describe('a link that drops while the reader is elsewhere', () => {
  /**
   * What the API would answer if asked, kept in step with what the hub has pushed.
   *
   * Both halves are needed and the reason is a race that is easy to write by accident: the
   * queries fetch once on mount, and that answer lands a beat after the test has already pushed
   * its own state through the hub. A handler left saying Disconnected undoes the setup from
   * underneath, and the test then fails describing a console that behaved correctly.
   */
  let link: { state: ConnectionState; failure: BrokerFailure | null };
  let supervisor: ReconnectStatus;

  beforeEach(() => {
    resetLinkWatch();
    link = { state: 'Disconnected', failure: null };
    supervisor = {
      enabled: true,
      active: false,
      attempt: 0,
      nextAttemptAt: null,
      gaveUp: false,
      now: '2026-09-02T21:00:00.000Z',
    };

    server.use(
      http.get('/api/connection', () => HttpResponse.json(link)),
      http.get('/api/connection/reconnect', () => HttpResponse.json(supervisor)),
    );
  });

  const failure: BrokerFailure = {
    reason: 'brokerClosed',
    host: 'broker.local',
    port: 1883,
    clientId: 'console',
    useTls: false,
    transport: 'tcp',
    protocolVersion: 'v311',
  };

  const menu = () => within(screen.getByRole('navigation', { name: 'Panels' }));

  const brokerButton = () => menu().getByRole('button', { name: /^Broker/ });

  // Through the hub rather than by writing the query cache, because that is how a drop actually
  // reaches a console — and because a cache written by hand is overwritten by the fetch the query
  // makes on mount, which lands a beat later saying Disconnected and undoes the whole setup.
  function renderApp() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hub = createFakeHub();

    const view = render(
      <QueryClientProvider client={queryClient}>
        <App hub={hub} />
      </QueryClientProvider>,
    );

    /** The server telling every console what the link is now, and remembering it said so. */
    const says = async (state: ConnectionState) => {
      link = { state, failure: state === 'Faulted' ? failure : null };

      await act(async () => {
        hub.emit('connectionStateChanged', link);
      });
    };

    /** And what is being done about it. */
    const supervising = async (over: Partial<ReconnectStatus>) => {
      supervisor = { ...supervisor, ...over };

      await act(async () => {
        hub.emit('reconnectStatusChanged', supervisor);
      });
    };

    return { ...view, says, supervising };
  }

  /** Somewhere that is not the Broker panel, which is where the reader has to be for any of this. */
  const goElsewhere = async () => {
    await userEvent.click(menu().getByRole('button', { name: 'Filters' }));
    await waitFor(() =>
      expect(brokerButton()).toHaveAttribute('aria-expanded', 'false'),
    );
  };

  // The requirement: a link that goes down because of a fault brings the reader to the panel that
  // can explain it. They should not have to go looking for the reason.
  it('opens the broker panel by itself', async () => {
    const { says } = renderApp();
    await says('Connected');
    await goElsewhere();

    await says('Faulted');

    await waitFor(() => expect(brokerButton()).toHaveAttribute('aria-expanded', 'true'));
    expect(await screen.findByText(/The link to broker\.local:1883/)).toBeInTheDocument();
  });

  // A Connect the reader pressed and that failed is not a disconnection. The panel is already
  // open and in front of them, and there is no outage to report.
  it('leaves a failed connect alone', async () => {
    const { says } = renderApp();
    await goElsewhere();

    await says('Faulted');

    await waitFor(() => expect(brokerButton()).toHaveAttribute('aria-expanded', 'false'));
  });

  // The other half of the requirement, and the one the panel had to be taught: a link coming back
  // normally closes this panel after a beat, because normally the reader asked for it. Here they
  // did not, and closing it would take the answer away at the moment it arrived.
  it('does not close the panel when the link comes back', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await goElsewhere();

    await says('Faulted');
    await supervising({ active: true, attempt: 2 });
    await waitFor(() => expect(brokerButton()).toHaveAttribute('aria-expanded', 'true'));

    await says('Connected');

    // Well past the settle the panel would otherwise close on.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(brokerButton()).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Reconnected')).toBeInTheDocument();
    // And the error is still on screen, which is the point of keeping the panel.
    expect(screen.getByText(/The broker closed the connection/)).toBeInTheDocument();
  });

  // The hold has to be released, or the panel would reopen itself at the next thing that touched
  // the link — for the rest of the session.
  it('a panel the reader closes stays closed', async () => {
    const { says } = renderApp();
    await says('Connected');
    await goElsewhere();
    await says('Faulted');
    await waitFor(() => expect(brokerButton()).toHaveAttribute('aria-expanded', 'true'));

    await userEvent.click(screen.getByRole('button', { name: 'Close Broker panel' }));

    await says('Connected');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(brokerButton()).toHaveAttribute('aria-expanded', 'false');
  });

  // Two blocks printing the same sentence reads as two different things having gone wrong. The
  // one with the buttons that answer it wins.
  it('says what broke the link once, not twice', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await says('Faulted');
    await supervising({ active: true, attempt: 1 });

    expect(await screen.findAllByText(/The broker closed the connection/)).toHaveLength(1);
  });

  // The connect that never happened. A console opened over a broker it has never reached shows
  // no notice at all, which is what every other test in this suite depends on.
  it('says nothing at all before anything has been connected', async () => {
    renderApp();

    await waitFor(() => expect(brokerButton()).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.queryByText('Reconnecting')).not.toBeInTheDocument();
    expect(screen.queryByText('Not reconnecting')).not.toBeInTheDocument();
  });

  it('the notice offers the stop that the supervisor honours', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await says('Faulted');
    await supervising({ active: true, attempt: 1, nextAttemptAt: '2026-09-02T21:00:08.000Z' });

    let called = false;
    server.use(
      http.delete('/api/connection/reconnect', () => {
        called = true;

        return HttpResponse.json({
          enabled: true,
          active: false,
          attempt: 1,
          nextAttemptAt: null,
          gaveUp: true,
          now: '2026-09-02T21:00:03.000Z',
        });
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Stop trying' }));

    await waitFor(() => expect(called).toBe(true));
  });
});
