import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { createFakeHub } from '../../realtime/fakeHub';
import { resetLinkWatch } from '../../stores/linkWatchStore';
import { server } from '../../test/server';
import type {
  BrokerFailure,
  BrokerLink,
  ConnectionState,
  ConnectionStateResponse,
  ReconnectStatus,
} from '../../types/api';

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
  /** What the API hands back for a live link, which is what the summary is drawn from. */
  const CONNECTION: BrokerLink = {
    host: 'broker.local',
    port: 1883,
    clientId: 'console',
    username: null,
    useTls: false,
    connectedAt: '2026-09-02T21:00:00.000Z',
    sessionPresent: false,
    assignedClientId: null,
    serverKeepAlive: 60,
    transport: 'tcp',
    protocolVersion: 'v311',
  };

  let link: ConnectionStateResponse;
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
      link = {
        state,
        failure: state === 'Faulted' ? failure : null,
        connection: state === 'Connected' ? CONNECTION : null,
      };

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
    expect(screen.getByText(/broker closed the connection/)).toBeInTheDocument();
  });

  /**
   * The panel that stayed is still a panel over a live link, and shows what one shows.
   *
   * This is the case the settle beat had to be taught. It used to end only by the panel closing,
   * which was true while closing was the only thing that could happen next — and stopped being
   * true the moment a fault-opened panel was allowed to stay. Latched on, it held the panel in
   * its 'no link' face: the reader got the whole form back, under a notice telling them the link
   * had come back. Every test in the suite passed while it did.
   */
  it('shows the live link, not the form, once it is back', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await goElsewhere();
    await says('Faulted');
    await supervising({ active: true, attempt: 1 });
    await waitFor(() => expect(brokerRow()).toHaveAttribute('aria-expanded', 'true'));

    await says('Connected');

    // Past the settle the panel would otherwise have closed on.
    await waitFor(() => expect(screen.queryByLabelText('Address')).not.toBeInTheDocument(), {
      timeout: 2_000,
    });
    expect(await screen.findByLabelText('Connection details')).toBeInTheDocument();
    // And the notice is still there, which is the whole reason the panel stayed.
    expect(screen.getByText('Reconnected')).toBeInTheDocument();
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

    expect(await screen.findAllByText(/broker closed the connection/)).toHaveLength(1);
  });

  // The connect that never happened. A console opened over a broker it has never reached shows
  // no notice at all, which is what every other test in this suite depends on.
  it('says nothing at all before anything has been connected', async () => {
    renderApp();

    await waitFor(() => expect(brokerButton()).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.queryByText('Reconnecting')).not.toBeInTheDocument();
    expect(screen.queryByText('Not reconnecting')).not.toBeInTheDocument();
  });

  // ---- what the rail says, which is the only place the link's state is said at all ----

  const brokerRow = () => menu().getByRole('button', { name: /^Broker/ });

  /**
   * Amber is the state that was missing.
   *
   * Red said 'there is no link'. It said it for a broker that had gone for good and for one three
   * seconds off coming back, which are the two cases a reader most needs told apart — and, because
   * a ladder puts the link through Faulted → Connecting → Faulted once a rung, it said it in
   * flashes that read as a fault repeating rather than as one outage being worked on.
   */
  it('goes amber while an outage is being worked on', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await says('Faulted');

    await supervising({ active: true, attempt: 2, nextAttemptAt: '2026-09-02T21:00:08.000Z' });

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Retrying'));
    expect(
      menu().getByRole('button', { name: 'Broker, reconnecting to the broker' }),
    ).toBeInTheDocument();
  });

  // The rung's own dial, which the link reports as Connecting. The row must not change colour for
  // it: one outage is one state, however many times the socket is picked up and put down.
  it('stays amber through the dial each rung makes', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await says('Faulted');
    await supervising({ active: true, attempt: 1, nextAttemptAt: '2026-09-02T21:00:02.000Z' });
    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Retrying'));

    await says('Connecting');

    expect(brokerRow()).toHaveAttribute('data-link', 'Retrying');
  });

  it('goes red once nobody is working on it any more', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await says('Faulted');
    await supervising({ active: true, attempt: 1 });
    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Retrying'));

    await supervising({ active: false, gaveUp: true });

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Faulted'));
  });

  // The row loses the live link's address the moment the link goes, which is the moment a reader
  // most wants to know which broker it was. The failure carries the endpoint for exactly this.
  it('still names the broker while the link is down', async () => {
    const { says } = renderApp();
    await says('Connected');
    await says('Faulted');

    await waitFor(() =>
      expect(brokerRow()).toHaveAttribute('title', 'Broker · broker.local:1883'),
    );
  });

  // Every face the notice draws is a state with no link, which is a panel already showing the
  // form — and the form carries the switch. A second copy inside the block was two checkboxes for
  // one setting on one screen.
  it('offers exactly one auto-reconnect switch during an outage', async () => {
    const { says, supervising } = renderApp();
    await says('Connected');
    await says('Faulted');
    await supervising({ active: true, attempt: 1, nextAttemptAt: '2026-09-02T21:00:08.000Z' });

    await screen.findByText('Reconnecting');
    expect(screen.getAllByRole('checkbox', { name: /Reconnect automatically/ })).toHaveLength(1);
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
