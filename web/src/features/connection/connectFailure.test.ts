import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/problemDetails';
import { describeConnectFailure, describeFailureReason, suggestScheme } from './connectFailure';

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
    [
      'tlsCertUntrusted',
      "broker.local presented a certificate this machine doesn't trust — point Extra CA " +
        'certificate at the CA that signed it, or accept any certificate if it is your own broker.',
    ],
    ['tlsCertExpired', 'The certificate for broker.local has expired.'],
    [
      'tlsCertNameMismatch',
      'The certificate at broker.local:1883 was issued for a different name — set Server name ' +
        'if the broker is reached by an address its certificate does not carry.',
    ],

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

// ---- what the transport and the version change about the advice ----

describe('a failure that depends on how the connection was being made', () => {
  const overWs = { ...FORM, transport: 'webSocket' as const };

  // Same silence, different fix. Over TCP the thing to check is the port; over a WebSocket the
  // port already answered — an upgrade completed — so what is left is the path.
  it('sends a WebSocket attempt to look at the path, not the port', () => {
    expect(describeConnectFailure(refusal('noMqttResponse'), overWs)).toBe(
      "broker.local:1883 opened a WebSocket but didn't speak MQTT over it — check the path, " +
        'and that this is the broker rather than something else on the same host.',
    );
  });

  it('says an upgrade was refused when the handshake never opened one', () => {
    expect(describeConnectFailure(refusal('webSocketUpgradeRejected'), overWs)).toBe(
      "broker.local:1883 answered the WebSocket request without opening one — the path is " +
        'usually the reason, and /mqtt is what nearly every broker uses.',
    );
  });

  // A version that was asked for by name is named back, and the reader is pointed at the
  // setting that exists so they never have to know the number.
  it('names the version that was refused, and where to stop caring', () => {
    expect(
      describeConnectFailure(refusal('protocolVersionUnsupported'), {
        ...FORM,
        protocolVersion: 'v311',
      }),
    ).toBe(
      "The broker at broker.local:1883 doesn't speak MQTT 3.1.1 — set the version to Auto and " +
        'it will find one they both know.',
    );
  });

  // Auto already walked the whole ladder, so there is no version left to suggest.
  it('does not suggest Auto to an attempt that already was Auto', () => {
    expect(describeConnectFailure(refusal('noSupportedProtocolVersion'), FORM)).toBe(
      'broker.local:1883 refused MQTT 5.0, 3.1.1 and 3.1 — whatever is on that port, it isn\'t ' +
        'a broker this console can talk to.',
    );
  });

  // MQTT 3.1's own limit, which the broker's refusal does not mention.
  it('explains a rejected client ID on 3.1 by the length the specification allows', () => {
    expect(
      describeConnectFailure(refusal('clientIdRejected'), { ...FORM, protocolVersion: 'v310' }),
    ).toContain('MQTT 3.1 allows at most 23 characters.');
  });

  it('says nothing about length when the version has no such limit', () => {
    expect(
      describeConnectFailure(refusal('clientIdRejected'), { ...FORM, protocolVersion: 'v500' }),
    ).toBe("The broker rejected the client ID 'mqttforge-console'.");
  });

  // Ours, not theirs, and each says which end to look at.
  it.each([
    ['clientCertificateRequired', 'want a client certificate and none was sent'],
    ['clientCertificateRejected', 'would not accept the client certificate'],
    ['certificateFileUnreadable', 'A certificate file could not be read'],
  ])('points %s at the right end of the connection', (reason, fragment) => {
    expect(describeConnectFailure(refusal(reason), FORM)).toContain(fragment);
  });
});

// The advice these sentences already give, as something the reader can press.
describe('the scheme worth offering after a failure', () => {
  const attempt = (over: Record<string, unknown> = {}) => ({
    ...FORM,
    transport: 'tcp' as const,
    ...over,
  });

  // Not a guess: the broker said it does not take encrypted connections.
  it('offers the plain twin when the broker refuses encryption', () => {
    expect(suggestScheme('tlsNotOffered', attempt({ useTls: true, port: 8883 }))).toMatchObject({
      scheme: 'mqtt',
    });
    expect(
      suggestScheme('tlsNotOffered', attempt({ useTls: true, transport: 'webSocket', port: 8084 })),
    ).toMatchObject({ scheme: 'ws' });
  });

  // A guess, kept to the one shape where a guess is nearly always right.
  it.each(['timeout', 'refused', 'noMqttResponse'])(
    'offers the encrypted twin when %s comes back off the encrypted port',
    (reason) => {
      expect(suggestScheme(reason, attempt({ useTls: false, port: 8883 }))).toMatchObject({
        scheme: 'mqtts',
      });
    },
  );

  it('offers the encrypted WebSocket for the WebSocket encrypted port', () => {
    expect(
      suggestScheme('timeout', attempt({ useTls: false, transport: 'webSocket', port: 8084 })),
    ).toMatchObject({ scheme: 'wss' });
  });

  it('says why, naming the broker rather than the rule', () => {
    expect(suggestScheme('timeout', attempt({ useTls: false, port: 8883 }))?.why).toContain('8883');
  });

  it.each([
    ['a port that implies nothing', 'timeout', { useTls: false, port: 1883 }],
    ['a reason about the path', 'webSocketUpgradeRejected', { useTls: false, port: 8083 }],
    ['a reason about the password', 'credentialsRejected', { useTls: false, port: 8883 }],
    ['an attempt that was already encrypted', 'timeout', { useTls: true, port: 8883 }],
    ['no reason at all', undefined, { useTls: false, port: 8883 }],
  ])('offers nothing for %s', (_what, reason, over) => {
    expect(suggestScheme(reason, attempt(over))).toBeUndefined();
  });

  // tlsNotOffered on an attempt that was not encrypted is a backend saying something about a
  // connection this one was not. Nothing to flip.
  it('offers nothing when the encryption refusal is about an unencrypted attempt', () => {
    expect(suggestScheme('tlsNotOffered', attempt({ useTls: false, port: 1883 }))).toBeUndefined();
  });
});
