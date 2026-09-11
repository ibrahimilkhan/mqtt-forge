import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import { BrokerEvents } from './BrokerEvents';

const happened = (what: string, detail?: string) =>
  useBrokerEventsStore.getState().push({ kind: 'ok', what, detail });

const rows = () => screen.queryAllByRole('listitem');

/** The box is behind a mark now: a reader who wants to search says so first. */
const openSearch = () => userEvent.click(screen.getByRole('button', { name: 'Find in the record' }));

beforeEach(() => useBrokerEventsStore.getState().clear());
afterEach(() => Reflect.deleteProperty(navigator, 'clipboard'));

describe('the record of what the link has done', () => {
  it('says how many events it is holding', () => {
    happened('Connected');
    happened('Link dropped');

    render(<BrokerEvents />);

    expect(screen.getByRole('heading', { name: /^Events/ })).toHaveTextContent('(2)');
  });

  it('counts nothing as nothing', () => {
    render(<BrokerEvents />);

    expect(screen.getByRole('heading', { name: /^Events/ })).toHaveTextContent('(0)');
    expect(screen.getByText('No events recorded yet.')).toBeInTheDocument();
  });

  describe('searching it', () => {
    beforeEach(() => {
      happened('Connected', 'mqtt.hsl.fi:8883');
      happened('Subscribe failed', 'Not authorised (135)');
      happened('Link dropped');
    });

    it('keeps the lines that carry the words, whichever part of the line they are in', async () => {
      render(<BrokerEvents />);
      await openSearch();

      await userEvent.type(screen.getByLabelText('Search broker events'), 'authorised');

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toHaveTextContent('Subscribe failed');
    });

    it('does not mind the case', async () => {
      render(<BrokerEvents />);
      await openSearch();

      await userEvent.type(screen.getByLabelText('Search broker events'), 'CONNECTED');

      expect(rows()).toHaveLength(1);
    });

    it('says how much of the record is being shown', async () => {
      render(<BrokerEvents />);
      await openSearch();

      await userEvent.type(screen.getByLabelText('Search broker events'), 'dropped');

      expect(screen.getByRole('heading', { name: /^Events/ })).toHaveTextContent('(1 of 3)');
    });

    // A record with nothing in it and a search matching nothing are two different answers, and
    // the reader who has just typed needs to know which one they are looking at.
    it('says so when nothing matches, rather than reading as an empty record', async () => {
      render(<BrokerEvents />);
      await openSearch();

      await userEvent.type(screen.getByLabelText('Search broker events'), 'zzz');

      expect(screen.getByText(/No event says/)).toBeInTheDocument();
      expect(screen.queryByText('No events recorded yet.')).not.toBeInTheDocument();
    });

    it('gives the whole record back when the box is cleared', async () => {
      render(<BrokerEvents />);
      await openSearch();
      await userEvent.type(screen.getByLabelText('Search broker events'), 'dropped');

      await userEvent.click(screen.getByRole('button', { name: 'Clear the search in broker events' }));

      expect(rows()).toHaveLength(3);
    });
  });

  describe('copying it', () => {
    const written: string[] = [];

    beforeEach(() => {
      written.length = 0;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => void written.push(text) },
      });
    });

    it('takes the time, the line and the reason', async () => {
      happened('Subscribe failed', 'Not authorised (135)');
      render(<BrokerEvents />);

      await userEvent.click(screen.getByRole('button', { name: 'Copy the broker events shown' }));

      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^\d\d:\d\d:\d\d {2}Subscribe failed — Not authorised \(135\)$/);
    });

    // What is on screen, not what is held: a search is how a reader picks the six lines about
    // one outage out of an afternoon of them.
    it('takes what the search left, not the whole record', async () => {
      happened('Connected');
      happened('Link dropped');
      render(<BrokerEvents />);
      await openSearch();
      await userEvent.type(screen.getByLabelText('Search broker events'), 'dropped');

      await userEvent.click(screen.getByRole('button', { name: 'Copy the broker events shown' }));

      expect(written[0]).toContain('Link dropped');
      expect(written[0]).not.toContain('Connected');
    });

    it('says it copied', async () => {
      happened('Connected');
      render(<BrokerEvents />);

      await userEvent.click(screen.getByRole('button', { name: 'Copy the broker events shown' }));

      // The mark alone says it, so what it says is its name.
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });

    it('has nothing to offer on an empty record', () => {
      render(<BrokerEvents />);

      expect(screen.getByRole('button', { name: 'Copy the broker events shown' })).toBeDisabled();
    });
  });

  describe('clearing it', () => {
    it('empties the record', async () => {
      happened('Connected');
      happened('Link dropped');
      render(<BrokerEvents />);

      await userEvent.click(screen.getByRole('button', { name: 'Clear the broker events' }));

      expect(useBrokerEventsStore.getState().events).toEqual([]);
      expect(screen.getByText('No events recorded yet.')).toBeInTheDocument();
    });

    // Otherwise the card comes back saying 'no event says dropped' about a record that is empty
    // for a different reason.
    it('drops the search with it', async () => {
      happened('Link dropped');
      render(<BrokerEvents />);
      await openSearch();
      await userEvent.type(screen.getByLabelText('Search broker events'), 'dropped');

      await userEvent.click(screen.getByRole('button', { name: 'Clear the broker events' }));

      expect(screen.getByLabelText('Search broker events')).toHaveValue('');
      expect(screen.getByText('No events recorded yet.')).toBeInTheDocument();
    });

    it('offers nothing to clear on an empty record', () => {
      render(<BrokerEvents />);

      expect(screen.getByRole('button', { name: 'Clear the broker events' })).toBeDisabled();
    });
  });

  it('holds the newest of a long record and says how many there are', () => {
    for (let i = 0; i < 60; i++) happened(`Try ${i} failed`);

    render(<BrokerEvents />);

    expect(rows()).toHaveLength(40);
    expect(screen.getByRole('heading', { name: /^Events/ })).toHaveTextContent('(60)');
    expect(within(rows()[0]).getByText('Try 59 failed')).toBeInTheDocument();
  });
});
