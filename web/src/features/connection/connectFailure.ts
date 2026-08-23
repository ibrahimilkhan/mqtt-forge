import { ApiError } from '../../lib/problemDetails';
import type { MqttProtocolLevel, MqttTransport } from '../../types/api';
import { choiceOf, schemeOf, versionName, type Scheme } from './scheme';

/**
 * What the console knows about the attempt that failed.
 *
 * The transport and the version are here because half the advice worth giving depends on them:
 * a broker that answers with something that is not MQTT means "check the port" over TCP and
 * "check the path" over a WebSocket, and a version that was refused is only worth naming when
 * somebody chose it by hand.
 */
export type Attempt = {
  host: string;
  port: number;
  clientId: string;
  useTls: boolean;
  transport?: MqttTransport;
  protocolVersion?: MqttProtocolLevel;
};

const overWebSocket = (attempt: Attempt) => attempt.transport === 'webSocket';

// The backend classifies the failure; the wording lives here, next to the panel that shows it.
// One table for both routes in — a reason means the same thing however it reached us.
const SENTENCE: Record<string, (attempt: Attempt) => string> = {
  // Never got as far as a broker
  hostNotFound: ({ host }) => `No host named ${host}.`,
  nameLookupFailed: ({ host }) => `Couldn't look up ${host} — the name server didn't answer.`,
  unreachable: ({ host }) => `${host} can't be reached from this machine.`,
  blockedLocally: ({ host, port }) => `This machine blocked the connection to ${host}:${port}.`,
  refused: ({ host, port }) => `Nothing is listening at ${host}:${port}.`,
  timeout: ({ host, port }) => `${host}:${port} didn't respond in time.`,

  // Something answered, but not a broker we could talk to. The advice that helps depends on
  // what the user already picked, so these read the attempt rather than a fixed string.
  noMqttResponse: (attempt) =>
    overWebSocket(attempt)
      ? `${attempt.host}:${attempt.port} opened a WebSocket but didn't speak MQTT over it — ` +
        'check the path, and that this is the broker rather than something else on the same host.'
      : `${attempt.host}:${attempt.port} answered, but not as an MQTT broker — check the port number` +
        (attempt.useTls ? '.' : ', and whether it needs TLS.'),
  tlsNotOffered: ({ host, port }) =>
    `${host}:${port} doesn't accept encrypted connections — switch to mqtt://, or use the broker's TLS port.`,

  // The WebSocket half never completed. Two causes, and the sentence used to name only the
  // first: the path is wrong, or that port is not a WebSocket port at all — which is what
  // pointing a WebSocket at 1883 does, measured against the lab.
  webSocketUpgradeRejected: ({ host, port }) =>
    `${host}:${port} did not open a WebSocket — check the path, or whether that port speaks ` +
    'WebSocket at all.',

  // A version was asked for by name and refused. Worth naming the version: the reader chose it,
  // and Auto exists precisely so they do not have to.
  protocolVersionUnsupported: ({ host, port, protocolVersion }) =>
    `The broker at ${host}:${port} doesn't speak ${versionName(protocolVersion ?? 'v500')} — ` +
    'set the version to Auto and it will find one they both know.',

  // Auto already did that, and there was nothing left to find.
  noSupportedProtocolVersion: ({ host, port }) =>
    `${host}:${port} refused MQTT 5.0, 3.1.1 and 3.1 — whatever is on that port, it isn't a ` +
    'broker this console can talk to.',

  // The encrypted channel could not be established
  tlsFailed: ({ host }) => `The encrypted connection to ${host} couldn't be set up.`,
  tlsCertUntrusted: ({ host }) =>
    `${host} presented a certificate this machine doesn't trust — point Extra CA certificate at ` +
    'the CA that signed it, or accept any certificate if it is your own broker.',
  tlsCertExpired: ({ host }) => `The certificate for ${host} has expired.`,
  tlsCertNameMismatch: ({ host, port }) =>
    `The certificate at ${host}:${port} was issued for a different name — set Server name ` +
    'if the broker is reached by an address its certificate does not carry.',

  // Our certificate, not theirs. Both are qualified, because the broker did not say which of the
  // two happened: it ended the handshake, and what is known is what was sent to it.
  clientCertificateRequired: ({ host, port }) =>
    `${host}:${port} ended the encrypted handshake without accepting the connection. Brokers do ` +
    'this when they want a client certificate and none was sent.',
  clientCertificateRejected: ({ host }) =>
    `${host} would not accept the client certificate — check it was issued by a CA the broker ` +
    'knows, and that it has not expired.',
  certificateFileUnreadable: () =>
    'A certificate file could not be read. Check the path, and the password if it is a .pfx.',

  // A broker answered, and said no
  credentialsRequired: () => 'This broker needs a username and password.',
  credentialsRejected: () => 'The broker rejected the username or password.',
  banned: () => 'The broker has banned this client.',
  clientIdRejected: ({ clientId, protocolVersion }) =>
    `The broker rejected the client ID '${clientId}'.` +
    (protocolVersion === 'v310' ? ' MQTT 3.1 allows at most 23 characters.' : ''),
  brokerBusy: () => 'The broker is unavailable or too busy right now.',
  brokerRejected: () => 'The broker refused the connection over something this console sent.',

  // A broker that took us in and then refused what we asked of it. Never worded as an identity
  // problem: by DISCONNECT time the broker has already accepted who we are, and the broker this
  // was found on asks for no credentials at all.
  notPermitted: () =>
    'The broker refused something this console asked for and closed the connection — most often ' +
    'a subscription to a filter it does not allow.',
  filterRefused: () =>
    "The broker refused the topic filter and closed the connection — it doesn't allow one " +
    'covering this much of the tree.',

  // Nothing the backend could name. The connect path prefers the raw detail over this, that
  // being the only thing carrying any information at all; a link that dropped has no detail, and
  // this is better than the nothing it used to show.
  unknown: ({ host, port }) => `The connection to ${host}:${port} failed, and nothing said why.`,

  // A link that was up, and is not any more
  connectionLost: ({ host, port }) => `The connection to ${host}:${port} was lost.`,
  sessionTakenOver: ({ clientId }) => `Another client connected with the client ID '${clientId}'.`,
  brokerClosed: () => 'The broker closed the connection.',
  brokerShuttingDown: () => 'The broker is shutting down.',
  kicked: () => 'An administrator disconnected this client.',
};

// A reason read off the connection state, where there is no detail to fall back on. An
// unrecognised one says nothing: FAULTED in the top bar already carries that much.
export function describeFailureReason(
  reason: string | null | undefined,
  attempt: Attempt,
): string | undefined {
  return reason ? SENTENCE[reason]?.(attempt) : undefined;
}

// The one reason that asks for no sentence anywhere: the user stopped the attempt themselves,
// so they already know what happened and nothing went wrong to explain.
export const wasAborted = (error: unknown) =>
  error instanceof ApiError && error.reason === 'aborted';

// One line explaining why a connect attempt failed, or nothing when there is nothing to add.
export function describeConnectFailure(error: unknown, attempt: Attempt): string | undefined {
  if (!(error instanceof ApiError)) return undefined;

  // Field errors already print under the inputs they belong to.
  if (error.errors) return undefined;

  if (wasAborted(error)) return undefined;

  // A reason nothing could name: the backend's own words carry more than the standing sentence
  // for it, so they win here. On a dropped link there are no words and the sentence is all there
  // is, which is why it exists.
  if (error.reason === 'unknown' && error.message) return error.message;

  // An unrecognised reason — one a newer backend invented — falls back to the detail rather than
  // leaving the reader with a blank line.
  return describeFailureReason(error.reason, attempt) ?? error.message;
}

/** A scheme to offer instead, and the one line saying what makes it worth offering. */
export type SchemeSuggestion = { scheme: Scheme; why: string };

// Along the encryption axis, never across the transport — the same rule `schemeForPort` keeps,
// and for the same reason. None of these reasons announces a wrong transport, and offering one
// would be a second guess stacked on the first.
const TWIN: Readonly<Record<Scheme, Scheme>> = {
  mqtt: 'mqtts',
  mqtts: 'mqtt',
  ws: 'wss',
  wss: 'ws',
};

// The three ways an encrypted port answers a plain connection: it says nothing, it says no, or
// it says something that is not MQTT. All three are the same mistake.
const SILENCE = new Set(['timeout', 'refused', 'noMqttResponse']);

// The ports MQTT is registered on, which nothing serves a WebSocket at.
const TCP_PORTS = new Set([1883, 8883]);

/**
 * The scheme worth offering after a failure, and why — or nothing, which is most of the time.
 *
 * Two cases, and they are the same mistake seen from opposite sides: a connection aimed at a
 * port whose encryption is not the one it asked for.
 *
 * `tlsNotOffered` is not a guess. The broker was reached and said it does not take encrypted
 * connections, so the plain twin is offered whatever the port is. The rest are guesses, and are
 * held to the one shape where a guess is nearly always right: a plain scheme aimed at the
 * encrypted default for its own transport. 8883 answering nothing to plain MQTT is not a mystery.
 *
 * Everything else gets nothing. A refused WebSocket upgrade is about the path and says so
 * already; a rejected password is about the password. An offer on either would be noise standing
 * where the real answer should be.
 */
export function suggestScheme(
  reason: string | null | undefined,
  attempt: Attempt,
): SchemeSuggestion | undefined {
  if (!reason) return undefined;

  const scheme = schemeOf(attempt.transport ?? 'tcp', attempt.useTls);

  if (reason === 'tlsNotOffered' && attempt.useTls) {
    return {
      scheme: TWIN[scheme],
      why: `${attempt.host}:${attempt.port} doesn't accept encrypted connections.`,
    };
  }

  if (SILENCE.has(reason) && !attempt.useTls && attempt.port === choiceOf(TWIN[scheme]).defaultPort) {
    return {
      scheme: TWIN[scheme],
      why: `${attempt.port} is the port brokers listen for encrypted connections on.`,
    };
  }

  // The one case that crosses the transport, and the evidence for it is a different kind: the
  // broker answered and did not speak WebSocket, on a port MQTT is registered on. A broker
  // serving a WebSocket at 1883 is not a thing anyone runs; a reader who picked ws:// out of
  // habit is.
  if (reason === 'webSocketUpgradeRejected' && TCP_PORTS.has(attempt.port)) {
    return {
      scheme: schemeOf('tcp', attempt.useTls),
      why: `${attempt.port} is a port MQTT is spoken on directly, not through a WebSocket.`,
    };
  }

  return undefined;
}
