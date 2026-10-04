import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RecentBroker } from '../../types/api';
import { RecentBrokers, briefly, since } from './RecentBrokers';

const connection = (over: Record<string, unknown> = {}) => ({
  host: 'broker.example',
  port: 1883,
  clientId: 'mqttforge-console',
  username: null,
  hasPassword: false,
  useTls: false,
  transport: 'tcp' as const,
  protocolVersion: 'auto' as const,
  webSocketPath: null,
  cleanSession: true,
  sessionExpiryInterval: null,
  tls: null,
  subscriptions: null,
  ...over,
});

const NOW = Date.parse('2026-09-12T12:00:00Z');

const broker = (over: Partial<RecentBroker> = {}): RecentBroker => ({
  id: 'abc123',
  connection: connection(),
  lastConnectedAt: '2026-09-12T09:00:00Z',
  ...over,
}) as RecentBroker;

const draw = (brokers: RecentBroker[], over: Record<string, unknown> = {}) => {
  const handlers = { onPick: vi.fn(), onForget: vi.fn() };
  render(
    <RecentBrokers brokers={brokers} active={null} now={NOW} {...handlers} {...over} />,
  );
  return handlers;
};

describe('the brokers this console reached', () => {
  // The section is drawn by having something to put in it, like the saved list under it.
  it('draws nothing at all when there is no history', () => {
    draw([]);

    expect(screen.queryByRole('group', { name: 'Recent' })).not.toBeInTheDocument();
  });

  // No name was ever typed for these, so the address is the heading: host and port, the way it is
  // typed into the form, with the scheme under it rather than eight characters in front of it.
  it('names each one by host and port, with the scheme under it', () => {
    draw([
      broker(),
      broker({ id: 'two', connection: connection({ host: 'other.example', port: 8883, useTls: true }) }),
      broker({ id: 'three', connection: connection({ host: 'lab.example', port: 21883 }) }),
    ]);

    // The port is drawn whatever it is — the scheme's own included.
    expect(screen.getByText('broker.example:1883')).toBeInTheDocument();
    expect(screen.getByText('other.example:8883')).toBeInTheDocument();
    expect(screen.getByText('lab.example:21883')).toBeInTheDocument();

    expect(screen.getByText('mqtts')).toBeInTheDocument();
    expect(screen.getAllByText('mqtt')).toHaveLength(2);
  });

  // The scheme is off the address line, so the whole endpoint is still in reach without pressing.
  it('carries the whole endpoint in the card title', () => {
    draw([broker()]);

    expect(screen.getByRole('button', { name: /^broker\.example:1883/ })).toHaveAttribute(
      'title',
      'mqtt://broker.example:1883',
    );
  });

  // It is nothing but colons, and an address written back without its brackets cannot be told
  // from its port.
  it('keeps an IPv6 host inside its brackets, ahead of its port', () => {
    draw([broker({ connection: connection({ host: '::1' }) })]);

    expect(screen.getByText('[::1]:1883')).toBeInTheDocument();
  });

  // Twice, for two readers: '3h' for the eye, the sentence for a screen reader.
  it('says how long ago it was reached', () => {
    draw([broker()]);

    expect(screen.getByText('3h')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('3 hours ago')).toBeInTheDocument();
  });

  // The spaces between the spans are drawn nowhere and exist only for this name. Pinned, so a
  // tidy-up that deletes them cannot pass silently.
  it('hands a screen reader the card as words with spaces between them', () => {
    draw([broker()]);

    expect(screen.getByRole('button', { name: 'broker.example:1883 mqtt 3 hours ago' })).toBeInTheDocument();
  });

  it('fills the form from the card body', async () => {
    const { onPick } = draw([broker()]);

    await userEvent.click(screen.getByRole('button', { name: /^broker\.example/ }));

    expect(onPick).toHaveBeenCalledWith(broker());
  });

  // Keeping one is the form's own Save, after the card has filled the form. Not a second, smaller
  // Save on every card.
  it('offers no Save of its own', () => {
    draw([broker()]);

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('forgets one by its id', async () => {
    const { onForget } = draw([broker()]);

    await userEvent.click(screen.getByRole('button', { name: 'Forget mqtt://broker.example:1883' }));

    expect(onForget).toHaveBeenCalledWith('abc123');
  });

  it('marks the one the form is holding', () => {
    draw([broker(), broker({ id: 'two', connection: connection({ host: 'other.example' }) })], {
      active: 'two',
    });

    // The card bodies alone: Forget names its broker too, and this is about the plate around the
    // body.
    const cards = [
      screen.getByRole('button', { name: /^broker\.example/ }),
      screen.getByRole('button', { name: /^other\.example/ }),
    ];

    expect(cards[0].parentElement).not.toHaveAttribute('data-active');
    expect(cards[1].parentElement).toHaveAttribute('data-active');
  });
});

// One rounded unit, because what this line answers is "this morning or last month".
describe('how long ago', () => {
  const at = (iso: string) => since(iso, NOW);

  it('says just now inside the first minute', () => {
    expect(at('2026-09-12T11:59:30Z')).toBe('just now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(at('2026-09-12T11:20:00Z')).toBe('40 minutes ago');
    expect(at('2026-09-12T09:00:00Z')).toBe('3 hours ago');
    expect(at('2026-09-09T12:00:00Z')).toBe('3 days ago');
  });

  it('keeps the singular for one of anything', () => {
    expect(at('2026-09-12T11:59:00Z')).toBe('1 minute ago');
    expect(at('2026-09-12T11:00:00Z')).toBe('1 hour ago');
    expect(at('2026-09-11T12:00:00Z')).toBe('1 day ago');
  });

  it('coarsens past a month and past a year', () => {
    expect(at('2026-06-12T12:00:00Z')).toBe('3 months ago');
    expect(at('2024-09-12T12:00:00Z')).toBe('2 years ago');
  });

  // A clock that disagrees with the server's, which is every clock. The card still has to read.
  it('does not count backwards from a time in the future', () => {
    expect(at('2026-09-12T12:00:30Z')).toBe('just now');
  });

  it('says something plain about a date it cannot read', () => {
    expect(at('not a date')).toBe('connected before');
  });
});

// The same age for the eye. Minutes are never a bare 'm', or '40m' and '2mo' ask which is months.
describe('how long ago, briefly', () => {
  const at = (iso: string) => briefly(iso, NOW);

  it('says now inside the first minute, and for a time in the future', () => {
    expect(at('2026-09-12T11:59:30Z')).toBe('now');
    expect(at('2026-09-12T12:00:30Z')).toBe('now');
  });

  it('writes a count and a unit that cannot be mistaken for another', () => {
    expect(at('2026-09-12T11:20:00Z')).toBe('40min');
    expect(at('2026-09-12T09:00:00Z')).toBe('3h');
    expect(at('2026-09-09T12:00:00Z')).toBe('3d');
    expect(at('2026-06-12T12:00:00Z')).toBe('3mo');
    expect(at('2024-09-12T12:00:00Z')).toBe('2y');
  });

  it('draws nothing for a date it cannot read', () => {
    expect(at('not a date')).toBeNull();
  });
});
