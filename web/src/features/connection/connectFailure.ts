import { ApiError } from '../../lib/problemDetails';
import { formatEndpoint } from './address';
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
  publish?: { rule: string; topic: string };
  traffic?: { messagesPerSecond: number; kilobytesPerSecond: number };
};

const overWebSocket = (attempt: Attempt) => attempt.transport === 'webSocket';

// The backend classifies the failure; the wording lives here, next to the panel that shows it.
// One table for both routes in — a reason means the same thing however it reached us.
const SENTENCE: Record<string, (attempt: Attempt) => string> = {
  // Never got as far as a broker
  hostNotFound: ({ host }) => `No host named ${host}.`,
  nameLookupFailed: ({ host }) => `Couldn't look up ${host} — the name server didn't answer.`,
  unreachable: ({ host }) => `${host} can't be reached from this machine.`,
  blockedLocally: ({ host, port }) => `This machine blocked the connection to ${formatEndpoint(host, port)}.`,
  refused: ({ host, port }) => `Nothing is listening at ${formatEndpoint(host, port)}.`,
  timeout: ({ host, port }) => `${formatEndpoint(host, port)} didn't respond in time.`,

  // Something answered, but not a broker we could talk to. The advice that helps depends on
  // what the user already picked, so these read the attempt rather than a fixed string.
  noMqttResponse: (attempt) =>
    overWebSocket(attempt)
      ? `${formatEndpoint(attempt.host, attempt.port)} opened a WebSocket but spoke no MQTT — check the path.`
      : `${formatEndpoint(attempt.host, attempt.port)} isn't an MQTT broker — check the port` +
        (attempt.useTls ? '.' : ' and TLS.'),
  // Accepted the socket and then closed it without a word. A broker at its connection limit does
  // exactly this, and so does a proxy that shut the tunnel — so the reader is not sent to check a
  // port number that was right.
  closedWithoutAnswering: (attempt) =>
    `${formatEndpoint(attempt.host, attempt.port)} closed the connection without answering — ` +
    (attempt.useTls ? 'broker full, or a proxy.' : 'broker full, a proxy, or TLS needed.'),

  tlsNotOffered: ({ host, port }) =>
    `${formatEndpoint(host, port)} doesn't accept TLS — use mqtt:// or the TLS port.`,

  // The WebSocket half never completed. Two causes, and the sentence used to name only the
  // first: the path is wrong, or that port is not a WebSocket port at all — which is what
  // pointing a WebSocket at 1883 does, measured against the lab.
  webSocketUpgradeRejected: ({ host, port }) =>
    `${formatEndpoint(host, port)} didn't open a WebSocket — check the path and port.`,

  // A version was asked for by name and refused. Worth naming the version: the reader chose it,
  // and Auto exists precisely so they do not have to.
  protocolVersionUnsupported: ({ host, port, protocolVersion }) =>
    `${formatEndpoint(host, port)} doesn't speak ${versionName(protocolVersion ?? 'v500')} — try Auto.`,

  // Auto already did that, and there was nothing left to find.
  noSupportedProtocolVersion: ({ host, port }) =>
    `${formatEndpoint(host, port)} refused MQTT 5.0, 3.1.1 and 3.1.`,

  // The encrypted channel could not be established
  tlsFailed: ({ host }) => `The encrypted connection to ${host} couldn't be set up.`,
  tlsCertUntrusted: ({ host }) =>
    `${host}'s certificate isn't trusted — set Extra CA certificate.`,
  tlsCertExpired: ({ host }) => `The certificate for ${host} has expired.`,
  tlsCertNameMismatch: ({ host, port }) =>
    `${formatEndpoint(host, port)}'s certificate is for another name — set Server name.`,

  // Our certificate, not theirs. Both are qualified, because the broker did not say which of the
  // two happened: it ended the handshake, and what is known is what was sent to it.
  clientCertificateRequired: ({ host, port }) =>
    `${formatEndpoint(host, port)} ended the TLS handshake — it may want a client certificate.`,
  clientCertificateRejected: ({ host }) =>
    `${host} rejected the client certificate.`,
  certificateFileUnreadable: () =>
    "Couldn't read the certificate file — check the path and password.",

  // A broker answered, and said no
  credentialsRequired: () => 'This broker needs a username and password.',
  credentialsRejected: () => 'The broker rejected the username or password.',
  // Not a password to correct. The broker wants an AUTH exchange — SCRAM, or a cloud's own
  // scheme — and this console speaks the username-and-password one only.
  authenticationMethodUnsupported: () =>
    'The broker wants MQTT 5 enhanced auth, not a username and password.',
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
    'The broker refused a request and closed the connection — likely a subscription.',
  filterRefused: () =>
    'The broker refused the topic filter and closed the connection.',
  // Read off the timing — the broker said nothing about a publish — so it says what happened in
  // that order rather than claiming the broker named it. The rule is what the reader goes to
  // change, so it is named; the topic is what to change it from.
  alertPublishRefused: ({ publish }) =>
    publish
      ? `The broker closed the connection right after alert rule '${publish.rule}' published to ` +
        `${publish.topic} — it doesn't accept publishing there. Change or remove the rule's publish action.`
      : "The broker closed the connection right after an alert rule published — it doesn't accept publishing there.",

  // Nothing the backend could name. The connect path prefers the raw detail over this, that
  // being the only thing carrying any information at all; a link that dropped has no detail, and
  // this is better than the nothing it used to show.
  unknown: ({ host, port }) => `The connection to ${formatEndpoint(host, port)} failed.`,

  // A link that was up, and is not any more
  connectionLost: ({ host, port }) => `The connection to ${formatEndpoint(host, port)} was lost.`,
  sessionTakenOver: ({ clientId }) => `Another client connected with the client ID '${clientId}'.`,
  brokerClosed: () => 'The broker closed the connection.',
  brokerShuttingDown: () => 'The broker is shutting down.',
  kicked: () => 'An administrator disconnected this client.',

  // Not the broker's doing, though it used to be put down as such: it was still sending when the
  // link went, and what ended it was this console not reading fast enough.
  fellBehind: ({ host, port, traffic }) =>
    `The console fell behind ${formatEndpoint(host, port)}` +
    (traffic ? `, which was sending about ${traffic.messagesPerSecond} messages a second,` : '') +
    ' and the link dropped with messages still arriving. A narrower filter keeps up.',
};

/**
 * The clause a container adds to a failure at a loopback address.
 *
 * Inside a container 'localhost' is the container, so a reader whose broker runs on the machine
 * hosting Docker is pointing at a host with nothing on it — and the sentence they get names an
 * address that looks exactly right. The console cannot know this by itself; the server says so
 * (see /api/connection/defaults) and this is what it is for.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * The clause a TLS connection on 443 with no ALPN protocol earns.
 *
 * AWS IoT Core carries MQTT on 443 only for clients that ask for it by name — `x-amzn-mqtt-ca` —
 * and to one that does not it looks like a port that accepts the connection and says nothing.
 * The sentence for that sends the reader to the certificate or the port, which are both right.
 */
export function alpnHint(attempt: Attempt, reason: string | null | undefined): string | undefined {
  const silent =
    reason === 'noMqttResponse' ||
    reason === 'closedWithoutAnswering' ||
    reason === 'tlsFailed';

  if (!silent || !attempt.useTls || attempt.port !== 443) return undefined;

  return (
    'On 443, AWS IoT Core needs ALPN x-amzn-mqtt-ca — set it under Security.'
  );
}

export function containerHint(host: string, inContainer: boolean | undefined): string | undefined {
  if (!inContainer || !LOOPBACK.has(host.trim().toLowerCase())) return undefined;

  return (
    'In a container this is the container itself — use host.docker.internal.'
  );
}

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
/**
 * The other scheme to try, and — where the failure sentence has not already said it — the reason
 * the offer makes sense at all.
 *
 * `why` is optional because one of the three cases does not need it: a broker that says it does
 * not take encrypted connections is told so in the sentence above the button, and a line
 * repeating it under that sentence would be one fact said twice on one screen, which reads as two
 * things having gone wrong. The other two are guesses from a port number, and a guess with no
 * reason attached is a button a reader has to take on faith.
 */
export type SchemeSuggestion = { scheme: Scheme; why?: string };

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

  // No `why`: `tlsNotOffered`'s own sentence already says the broker refuses encryption, and
  // says what to do about it.
  if (reason === 'tlsNotOffered' && attempt.useTls) return { scheme: TWIN[scheme] };

  if (SILENCE.has(reason) && !attempt.useTls && attempt.port === choiceOf(TWIN[scheme]).defaultPort) {
    return {
      scheme: TWIN[scheme],
      why: `${attempt.port} is a TLS port.`,
    };
  }

  // The one case that crosses the transport, and the evidence for it is a different kind: the
  // broker answered and did not speak WebSocket, on a port MQTT is registered on. A broker
  // serving a WebSocket at 1883 is not a thing anyone runs; a reader who picked ws:// out of
  // habit is.
  if (reason === 'webSocketUpgradeRejected' && TCP_PORTS.has(attempt.port)) {
    return {
      scheme: schemeOf('tcp', attempt.useTls),
      why: `${attempt.port} is a plain MQTT port, not a WebSocket one.`,
    };
  }

  return undefined;
}
