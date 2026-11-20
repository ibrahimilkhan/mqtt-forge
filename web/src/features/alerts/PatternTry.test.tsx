import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useLogStore } from '../../stores/logStore';
import { PatternTry } from './PatternTry';

const message = (topic: string, payload: string): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: payload.length,
  qos: 0,
  retain: false,
  receivedAt: '2026-11-19T10:00:00Z',
});

const send = (...messages: DecodedMessage[]) =>
  act(() => useLogStore.getState().appendReceived(messages));

const verdicts = () =>
  screen.getAllByTestId('try-row').map((row) => row.getAttribute('data-verdict'));

beforeEach(() => useLogStore.getState().clear());

describe('trying a pattern', () => {
  it('judges the recent messages on the rule’s topics, newest first', () => {
    send(message('d/1/log', 'boot ok'), message('d/2/log', 'ERROR disk'));
    render(<PatternTry regex="ERROR" negate={false} source={{ filter: 'd/+/log', field: '' }} />);

    expect(verdicts()).toEqual(['fires', 'quiet']);
    // A wildcard filter covers several topics, so each row says which one it came from.
    expect(within(screen.getAllByTestId('try-row')[0]).getByText('d/2/log')).toBeInTheDocument();
  });

  it('gives the rule’s answer, so does-not-match flips it', () => {
    send(message('t', 'boot ok'));
    render(<PatternTry regex="ERROR" negate source={{ filter: 't', field: '' }} />);

    expect(verdicts()).toEqual(['fires']);
  });

  it('reads the rule’s field, and skips a message that does not carry it', () => {
    send(message('t', '{"msg":"timeout"}'), message('t', '{"other":1}'));
    render(<PatternTry regex="timeout" negate={false} source={{ filter: 't', field: 'msg' }} />);

    expect(verdicts()).toEqual(['skipped', 'fires']);
    expect(screen.getByText(/field missing/)).toBeInTheDocument();
  });

  it('tries the reader’s own text, with no messages at all', async () => {
    render(<PatternTry regex="^ERR-" negate={false} source={{ filter: 'nothing/here', field: '' }} />);

    expect(screen.getByText(/No messages on this topic yet/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Try your own text'), 'ERR-7');
    expect(screen.getByTestId('own-verdict')).toHaveTextContent('fires');

    await userEvent.clear(screen.getByLabelText('Try your own text'));
    await userEvent.type(screen.getByLabelText('Try your own text'), 'ok');
    expect(screen.getByTestId('own-verdict')).toHaveTextContent('no');
  });

  it('says why an expression cannot be tried, in place of the verdicts', () => {
    send(message('t', 'x'));
    render(<PatternTry regex="([" negate={false} source={{ filter: 't', field: '' }} />);

    expect(screen.getByText(/Not a valid expression/)).toBeInTheDocument();
    expect(screen.queryByTestId('try-row')).not.toBeInTheDocument();
  });

  it('holds its rows still while traffic arrives, until Refresh', async () => {
    send(message('t', 'first'));
    render(<PatternTry regex="x" negate={false} source={{ filter: 't', field: '' }} />);

    send(message('t', 'second'));
    expect(screen.getAllByTestId('try-row')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getAllByTestId('try-row')).toHaveLength(2);
  });
});
