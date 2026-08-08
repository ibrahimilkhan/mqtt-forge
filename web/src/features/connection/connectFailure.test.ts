import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/problemDetails';
import { describeConnectFailure, describeFailureReason } from './connectFailure';

const FORM = { host: 'broker.local', port: 1883, clientId: 'mqfaker-console' };

const refusal = (reason?: string, message = 'raw backend detail') =>
  new ApiError(502, message, 'Could not connect to broker', undefined, reason);

describe('describeConnectFailure', () => {
  it.each([
    ['refused', 'Nothing is listening at broker.local:1883.'],
    ['hostNotFound', 'No host named broker.local.'],
    ['unreachable', "broker.local can't be reached from this machine."],
    ['timeout', "broker.local:1883 didn't respond in time."],
    ['tlsFailed', 'TLS handshake with broker.local failed.'],
    ['credentialsRejected', 'The broker rejected the username or password.'],
    ['clientIdRejected', "The broker rejected the client ID 'mqfaker-console'."],
    ['brokerBusy', 'The broker is unavailable or too busy right now.'],
  ])('words %s as a sentence', (reason, expected) => {
    expect(describeConnectFailure(refusal(reason), FORM)).toBe(expected);
  });

  it('falls back to the backend detail when the reason is unknown', () => {
    expect(describeConnectFailure(refusal('unknown', 'The broker refused (ProtocolError).'), FORM)).toBe(
      'The broker refused (ProtocolError).',
    );
  });

  // A reason the backend added after this build shipped must not blank the line out.
  it('falls back to the backend detail for a reason it has never heard of', () => {
    expect(describeConnectFailure(refusal('somethingNew', 'The broker refused.'), FORM)).toBe(
      'The broker refused.',
    );
  });

  it('falls back to the backend detail when there is no reason at all', () => {
    expect(describeConnectFailure(refusal(undefined, 'HTTP 502'), FORM)).toBe('HTTP 502');
  });

  // Those already print under the inputs they belong to.
  it('says nothing when the failure is field validation', () => {
    const error = new ApiError(400, 'Validation failed', 'Validation failed', {
      Host: ['Host is required'],
    });

    expect(describeConnectFailure(error, FORM)).toBeUndefined();
  });

  it('says nothing when there is no error', () => {
    expect(describeConnectFailure(null, FORM)).toBeUndefined();
  });
});

// A link that was up and is now down; the reason arrives on the connection state, not an error.
describe('describeFailureReason', () => {
  it.each([
    ['sessionTakenOver', "Another client connected with the client ID 'mqfaker-console'."],
    ['brokerClosed', 'The broker closed the connection.'],
    ['timeout', "broker.local:1883 didn't respond in time."],
  ])('words %s as a sentence', (reason, expected) => {
    expect(describeFailureReason(reason, FORM)).toBe(expected);
  });

  // No detail to fall back on here, and FAULTED in the top bar already says this much.
  it.each([['unknown'], ['somethingNew'], [undefined], [null]])(
    'says nothing for %s, rather than guessing',
    (reason) => {
      expect(describeFailureReason(reason, FORM)).toBeUndefined();
    },
  );
});
