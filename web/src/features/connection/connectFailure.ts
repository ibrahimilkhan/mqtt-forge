import { ApiError } from '../../lib/problemDetails';

type Attempt = { host: string; port: number; clientId: string; useTls: boolean };

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
  // what the user already ticked, so this one reads the attempt rather than a fixed string.
  noMqttResponse: ({ host, port, useTls }) =>
    `${host}:${port} answered, but not as an MQTT broker — check the port number` +
    (useTls ? '.' : ', and whether it needs TLS.'),
  tlsNotOffered: ({ host, port }) =>
    `${host}:${port} doesn't accept encrypted connections — turn off Use TLS, or use the broker's TLS port.`,
  protocolVersionUnsupported: ({ host, port }) => `The broker at ${host}:${port} doesn't speak MQTT 5.`,

  // The encrypted channel could not be established
  tlsFailed: ({ host }) => `The encrypted connection to ${host} couldn't be set up.`,
  tlsCertUntrusted: ({ host }) => `${host} presented a certificate this machine doesn't trust.`,
  tlsCertExpired: ({ host }) => `The certificate for ${host} has expired.`,
  tlsCertNameMismatch: ({ host, port }) =>
    `The certificate at ${host}:${port} was issued for a different name.`,

  // A broker answered, and said no
  credentialsRequired: () => 'This broker needs a username and password.',
  credentialsRejected: () => 'The broker rejected the username or password.',
  banned: () => 'The broker has banned this client.',
  clientIdRejected: ({ clientId }) => `The broker rejected the client ID '${clientId}'.`,
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

  // An unrecognised reason — including one a newer backend invented — falls back to the
  // detail rather than leaving the user with a blank line.
  return describeFailureReason(error.reason, attempt) ?? error.message;
}
