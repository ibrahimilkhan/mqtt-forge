import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { resetLinkWatch, useLinkWatchStore } from '../../stores/linkWatchStore';
import type { BrokerFailure, ConnectionState, ReconnectStatus } from '../../types/api';
import { ReconnectNotice } from './ReconnectNotice';

/**
 * The block a reader lands on when a link drops out from under them.
 *
 * Four faces and never more than one at a time. Each is a different answer to "what happened and
 * what is being done about it", and the wrong one is worse than none: telling somebody their link
 * dropped when their Connect simply failed sends them looking for a fault that is not there.
 */
describe('the reconnect notice', () => {
  beforeEach(resetLinkWatch);

  const failure: BrokerFailure = {
    reason: 'brokerClosed',
    host: 'broker.local',
    port: 1883,
    clientId: 'console',
    useTls: false,
    transport: 'tcp',
    protocolVersion: 'v311',
  };

  /** The API saying what the link is, and what the supervisor is doing about it. */
  function api(state: ConnectionState, status: Partial<ReconnectStatus> = {}) {
    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json({ state, failure: state === 'Faulted' ? failure : null }),
      ),
      http.get('/api/connection/reconnect', () =>
        HttpResponse.json({
          enabled: true,
          active: false,
          attempt: 0,
          nextAttemptAt: null,
          gaveUp: false,
          now: '2026-09-02T21:00:00.000Z',
          ...status,
        }),
      ),
    );
  }

  /** A link that was up and then went, which is the only thing this block is about. */
  function dropped() {
    const watch = useLinkWatchStore.getState();
    watch.saw('Connected', null);
    watch.saw('Faulted', failure, 1_000);
  }

  // ---- an outage being worked on ----

  describe('while it is trying', () => {
    it('says so, and says how many tries have gone', async () => {
      dropped();
      api('Faulted', {
        active: true,
        attempt: 3,
        nextAttemptAt: '2026-09-02T21:00:08.000Z',
      });

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText('Reconnecting')).toBeInTheDocument();
      expect(screen.getByText(/3 tries have failed so far/)).toBeInTheDocument();
      expect(screen.getByText(/The link to broker\.local:1883 dropped/)).toBeInTheDocument();
    });

    // The counter, which is the whole of "show me that you are trying". Eight seconds on the
    // server's clock, whatever this machine's clock says.
    it('counts down to the next try', async () => {
      dropped();
      api('Faulted', {
        active: true,
        attempt: 1,
        nextAttemptAt: '2026-09-02T21:00:08.000Z',
      });

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText('next try in 8s')).toBeInTheDocument();
    });

    // A dial in flight has no deadline, and 'in 0s' would be a countdown that had stopped rather
    // than an attempt that is running.
    it('says it is trying when a dial is actually in flight', async () => {
      dropped();
      api('Faulted', { active: true, attempt: 2, nextAttemptAt: null });

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText('trying…')).toBeInTheDocument();
    });

    it('says nothing about tries before the first one', async () => {
      dropped();
      api('Faulted', {
        active: true,
        attempt: 0,
        nextAttemptAt: '2026-09-02T21:00:01.000Z',
      });

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText(/Trying again shortly/)).toBeInTheDocument();
    });

    it('offers a way to stop it and a way to hurry it', async () => {
      dropped();
      api('Faulted', { active: true, attempt: 1, nextAttemptAt: '2026-09-02T21:00:08.000Z' });

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByRole('button', { name: 'Try now' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop trying' })).toBeInTheDocument();
    });

    it('stopping calls the outage off', async () => {
      dropped();
      api('Faulted', { active: true, attempt: 1, nextAttemptAt: '2026-09-02T21:00:08.000Z' });

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

      renderWithClient(<ReconnectNotice />);
      await userEvent.click(await screen.findByRole('button', { name: 'Stop trying' }));

      await waitFor(() => expect(called).toBe(true));
      // And the block turns into the face that offers a way back, off the answer alone — no
      // refetch between the click and the screen.
      expect(await screen.findByText('Not reconnecting')).toBeInTheDocument();
    });

    it('trying now dials without waiting for the rung', async () => {
      dropped();
      api('Faulted', { active: true, attempt: 1, nextAttemptAt: '2026-09-02T21:00:08.000Z' });

      let called = false;
      server.use(
        http.post('/api/connection/reconnect', () => {
          called = true;

          return HttpResponse.json({
            enabled: true,
            active: true,
            attempt: 2,
            nextAttemptAt: '2026-09-02T21:00:04.000Z',
            gaveUp: false,
            now: '2026-09-02T21:00:03.000Z',
          });
        }),
      );

      renderWithClient(<ReconnectNotice />);
      await userEvent.click(await screen.findByRole('button', { name: 'Try now' }));

      await waitFor(() => expect(called).toBe(true));
    });
  });

  // ---- an outage nobody is working on ----

  describe('when nothing is being tried', () => {
    it('says the reader stopped it', async () => {
      dropped();
      api('Faulted', { active: false, gaveUp: true, attempt: 4 });

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText('Not reconnecting')).toBeInTheDocument();
      expect(screen.getByText(/Reconnecting was stopped/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    });

    // A different sentence, because it is a different reason and only one of them is undone by
    // pressing Reconnect.
    it('says the option is off when that is why', async () => {
      dropped();
      api('Faulted', { enabled: false, active: false });

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText(/Auto-reconnect is off/)).toBeInTheDocument();
    });
  });

  // ---- a link that came back ----

  describe('when it comes back', () => {
    function recovered() {
      const watch = useLinkWatchStore.getState();
      watch.saw('Connected', null);
      watch.saw('Faulted', failure, 1_000);
      watch.saw('Connected', null, 35_000);
    }

    // The requirement in one test: the panel stays, the last error is still there, and it says
    // the link is back.
    it('says it is back, and still says what had broken it', async () => {
      recovered();
      api('Connected');

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText('Reconnected')).toBeInTheDocument();
      expect(screen.getByText(/It had dropped:/)).toBeInTheDocument();
      expect(screen.getByText(/broker closed the connection/)).toBeInTheDocument();
    });

    it('says how long it was gone', async () => {
      recovered();
      api('Connected');

      renderWithClient(<ReconnectNotice />);

      expect(await screen.findByText('gone for 34s')).toBeInTheDocument();
    });

    it('can be put away', async () => {
      recovered();
      api('Connected');

      renderWithClient(<ReconnectNotice />);
      await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(screen.queryByText('Reconnected')).not.toBeInTheDocument());
    });
  });

  // ---- nothing wrong ----

  describe('when there is nothing to report', () => {
    // The standing answer, set while nothing is wrong. It is the one control here that is not
    // about an outage, so it is the one that survives when there is no outage.
    it('a live link shows the switch and nothing else', async () => {
      api('Connected');

      renderWithClient(<ReconnectNotice />);

      expect(
        await screen.findByRole('checkbox', { name: /Reconnect automatically/ }),
      ).toBeInTheDocument();
      expect(screen.queryByText('Reconnecting')).not.toBeInTheDocument();
      expect(screen.queryByText('Reconnected')).not.toBeInTheDocument();
    });

    // The distinction the whole store turns on. A Connect that failed is the Broker panel's own
    // business, and a block telling the reader their link dropped would send them looking for a
    // fault that never happened.
    it('a connect that failed is not a dropped link', async () => {
      api('Faulted');

      renderWithClient(<ReconnectNotice />);

      await waitFor(() => expect(screen.queryByText('Not reconnecting')).not.toBeInTheDocument());
      expect(screen.queryByText('Reconnecting')).not.toBeInTheDocument();
    });

    it('a console that has connected to nothing shows no block at all', async () => {
      api('Disconnected');
      const { container } = renderWithClient(<ReconnectNotice />);

      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });
  });

  // ---- the option ----

  it('the switch is the standing answer, and it is sent', async () => {
    api('Connected');

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

    renderWithClient(<ReconnectNotice />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Reconnect automatically/ }));

    await waitFor(() => expect(sent).toEqual({ enabled: false }));
  });
});
