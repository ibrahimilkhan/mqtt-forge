import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { useHubStatusStore } from '../../stores/hubStatusStore';
import type { ConnectionState } from '../../types/api';
import { LinkChip } from './LinkChip';
import chipCss from './LinkChip.module.css?raw';
import { arrived } from './reconnectView';

/**
 * The chip at the top of both faces of the broker panel: one word and one tone per state.
 *
 * Worth its own file rather than being read off the panel's tests, because the thing being
 * pinned is the table — six states, six words, three tones — and a panel test can only ever see
 * the two states a panel is in. The mapping is what a later hand would break without noticing.
 */

afterEach(() => useHubStatusStore.setState({ status: 'live' }));

function draw(
  connection: ConnectionState | 'unanswered',
  reconnect: { active?: boolean } = {},
) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // 'unanswered' leaves the connection query with nothing in it, which is the state the console
  // is in for the first beat of every page load.
  if (connection !== 'unanswered') {
    query.setQueryData(queryKeys.connection, {
      state: connection,
      failure: null,
      connection: null,
    });
  }
  query.setQueryData(
    queryKeys.reconnect,
    arrived({
      enabled: true,
      active: false,
      attempt: 0,
      nextAttemptAt: null,
      gaveUp: false,
      now: '2026-09-12T00:00:00.000Z',
      ...reconnect,
    }),
  );

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );

  return render(<LinkChip />, { wrapper });
}

/** The chip itself, by the attribute its tone is drawn off. */
const chip = () => document.querySelector('[data-tone]');

describe('the word the chip says', () => {
  it('says there is a link, and lights its lamp for it', () => {
    draw('Connected');

    expect(chip()).toHaveTextContent('Connected');
    expect(chip()).toHaveAttribute('data-tone', 'live');
    // The one state that earns a filled lamp: a lamp that is on says 'this is so'.
    expect(document.querySelector('[data-lit]')).toBeInTheDocument();
  });

  it('says a connect is in flight', () => {
    draw('Connecting');

    expect(chip()).toHaveTextContent('Connecting');
    expect(chip()).toHaveAttribute('data-tone', 'working');
    expect(document.querySelector('[data-lit]')).not.toBeInTheDocument();
  });

  it('says an outage is being climbed back', () => {
    draw('Faulted', { active: true });

    expect(chip()).toHaveTextContent('Reconnecting');
    expect(chip()).toHaveAttribute('data-tone', 'working');
  });

  it('says a link that is down with nothing being done about it', () => {
    draw('Faulted');

    expect(chip()).toHaveTextContent('Faulted');
    expect(chip()).toHaveAttribute('data-tone', 'fault');
  });

  /* Not 'No server': MQTT's own vocabulary calls the broker the Server, so the one reading a
     reader must not be able to take from this is that the broker has gone. Nothing about the
     broker is known in this state — that is the state. */
  it('names the console, not the broker, when the console loses its own server', () => {
    useHubStatusStore.setState({ status: 'reconnecting' });
    draw('Connected');

    expect(chip()).toHaveTextContent('Console offline');
    expect(chip()).toHaveAttribute('data-tone', 'fault');
  });

  /* The oldest rule about this state. The console opens here, having been asked to do nothing,
     and a red that is on at rest is a red nobody looks at when it finally means something. */
  it('wears no colour at rest', () => {
    draw('Disconnected');

    expect(chip()).toHaveTextContent('Disconnected');
    expect(chip()).toHaveAttribute('data-tone', 'none');
  });

  // Six states, six words. Colour is never the only signal in this console, and the word is what
  // carries the state to a reader who cannot tell the three tones apart.
  it('gives every state a word of its own', () => {
    const said = new Set<string>();

    for (const [state, reconnect] of [
      ['Connected', {}],
      ['Connecting', {}],
      ['Faulted', { active: true }],
      ['Faulted', {}],
      ['Disconnected', {}],
    ] as const) {
      const view = draw(state, reconnect);
      said.add(chip()!.textContent!.trim());
      view.unmount();
    }

    useHubStatusStore.setState({ status: 'reconnecting' });
    draw('Connected');
    said.add(chip()!.textContent!.trim());

    expect(said.size).toBe(6);
  });
});

/**
 * The guess the console stands in until the API answers.
 *
 * `useConnectionState` substitutes Disconnected so nothing has to handle undefined, and a chip
 * drawn on that would state as a fact the one thing it cannot yet know — on a page reloaded over
 * a live link the form face renders first, and DISCONNECTED would flash at a reader whose broker
 * never went anywhere.
 */
describe('before the API has said anything', () => {
  it('says nothing rather than guessing', () => {
    draw('unanswered');

    expect(chip()).not.toBeInTheDocument();
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
  });
});

/**
 * The one thing about this chip that no test can see by rendering it.
 *
 * tokens.test.ts holds every ink in the palette to 4.5:1 against --paper AND --surface, and it
 * does that by reading `--name: #rrggbb` declarations out of tokens.css. A ground written as a
 * color-mix is outside its reach entirely — and the mix that looks most natural here, the state's
 * own colour washed into the panel's paper, is the one that fails: --warn falls to 4.25:1 at six
 * percent and --live to 4.36 at eight, measured. A wash over --surface does hold, but it lands
 * within 1.05:1 of the paper around it, so it costs the lift that makes the chip read as a chip
 * and buys nothing back.
 *
 * So the ground is a plain token and the test says so, because the next hand to reach for a tint
 * here will have no other way to find that out.
 */
describe("the chip's ground", () => {
  it('is a token rather than a mix, so the contrast test still covers its ink', () => {
    const ground = chipCss.match(/\.chip\s*\{[^}]*background:\s*([^;]+);/)?.[1];

    expect(ground).toBe('var(--surface)');
    expect(chipCss).not.toMatch(/background:[^;]*color-mix/);
  });
});
