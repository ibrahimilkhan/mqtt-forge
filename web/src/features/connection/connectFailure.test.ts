import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/problemDetails';
import { describeConnectFailure, describeFailureReason } from './connectFailure';

const FORM = { host: 'broker.local', port: 1883, clientId: 'mqttforge-console', useTls: false };

const refusal = (reason?: string, message = 'raw backend detail') =>
  new ApiError(502, message, 'Could not connect to broker', undefined, reason);

describe('describeConnectFailure', () => {
  it.each([
    ['refused', 'Nothing is listening at broker.local:1883.'],
    ['hostNotFound', 'No host named broker.local.'],
    ['nameLookupFailed', "Couldn't look up broker.local — the name server didn't answer."],
    ['unreachable', "broker.local can't be reached from this machine."],
    ['blockedLocally', 'This machine blocked the connection to broker.local:1883.'],
    ['timeout', "broker.local:1883 didn't respond in time."],
    ['tlsFailed', "The encrypted connection to broker.local couldn't be set up."],
    ['tlsCertUntrusted', "broker.local presented a certificate this machine doesn't trust."],
    ['tlsCertExpired', 'The certificate for broker.local has expired.'],
    ['tlsCertNameMismatch', 'The certificate at broker.local:1883 was issued for a different name.'],
    ['protocolVersionUnsupported', "The broker at broker.local:1883 doesn't speak MQTT 5."],
    ['credentialsRequired', 'This broker needs a username and password.'],
    ['credentialsRejected', 'The broker rejected the username or password.'],
    ['banned', 'The broker has banned this client.'],
    ['clientIdRejected', "The broker rejected the client ID 'mqttforge-console'."],
    ['brokerBusy', 'The broker is unavailable or too busy right now.'],
    ['brokerRejected', 'The broker refused the connection over something this console sent.'],
  ])('words %s as a sentence', (reason, expected) => {
    expect(describeConnectFailure(refusal(reason), FORM)).toBe(expected);
  });

  // Same cause, but the useful half of the advice depends on what the user already ticked.
  it('tells a plaintext attempt that the port might want TLS', () => {
    expect(describeConnectFailure(refusal('noMqttResponse'), FORM)).toBe(
      'broker.local:1883 answered, but not as an MQTT broker — check the port number, and whether it needs TLS.',
    );
  });

  it('does not suggest TLS to someone who already ticked it', () => {
    expect(describeConnectFailure(refusal('noMqttResponse'), { ...FORM, useTls: true })).toBe(
      'broker.local:1883 answered, but not as an MQTT broker — check the port number.',
    );
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
    ['sessionTakenOver', "Another client connected with the client ID 'mqttforge-console'."],
    ['brokerClosed', 'The broker closed the connection.'],
    ['brokerShuttingDown', 'The broker is shutting down.'],
    ['kicked', 'An administrator disconnected this client.'],
    ['connectionLost', 'The connection to broker.local:1883 was lost.'],
    ['timeout', "broker.local:1883 didn't respond in time."],
    [
      'notPermitted',
      'The broker refused something this console asked for and closed the connection — most often a subscription to a filter it does not allow.',
    ],
    [
      'filterRefused',
      "The broker refused the topic filter and closed the connection — it doesn't allow one covering this much of the tree.",
    ],
  ])('words %s as a sentence', (reason, expected) => {
    expect(describeFailureReason(reason, FORM)).toBe(expected);
  });

  // The bug these two exist for: a broker that asks for no credentials at all refused a wildcard
  // by closing the session, and the console told the reader their username or password was wrong.
  it.each([['notPermitted'], ['filterRefused']])(
    'does not blame credentials for %s',
    (reason) => {
      expect(describeFailureReason(reason, FORM)).not.toMatch(/username|password/i);
    },
  );

  // No detail to fall back on here, and FAULTED in the top bar already says this much.
  it.each([['unknown'], ['somethingNew'], [undefined], [null]])(
    'says nothing for %s, rather than guessing',
    (reason) => {
      expect(describeFailureReason(reason, FORM)).toBeUndefined();
    },
  );
});
