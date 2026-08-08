import { ApiError } from '../../lib/problemDetails';

type Attempt = { host: string; port: number; clientId: string };

// The backend classifies the failure; the wording lives here, next to the panel that shows it.
// One table for both routes in — a reason means the same thing however it reached us.
const SENTENCE: Record<string, (attempt: Attempt) => string> = {
  refused: ({ host, port }) => `Nothing is listening at ${host}:${port}.`,
  hostNotFound: ({ host }) => `No host named ${host}.`,
  unreachable: ({ host }) => `${host} can't be reached from this machine.`,
  timeout: ({ host, port }) => `${host}:${port} didn't respond in time.`,
  tlsFailed: ({ host }) => `TLS handshake with ${host} failed.`,
  credentialsRejected: () => 'The broker rejected the username or password.',
  clientIdRejected: ({ clientId }) => `The broker rejected the client ID '${clientId}'.`,
  brokerBusy: () => 'The broker is unavailable or too busy right now.',
  sessionTakenOver: ({ clientId }) => `Another client connected with the client ID '${clientId}'.`,
  brokerClosed: () => 'The broker closed the connection.',
};

// A reason read off the connection state, where there is no detail to fall back on. An
// unrecognised one says nothing: FAULTED in the top bar already carries that much.
export function describeFailureReason(
  reason: string | null | undefined,
  attempt: Attempt,
): string | undefined {
  return reason ? SENTENCE[reason]?.(attempt) : undefined;
}

// One line explaining why a connect attempt failed, or nothing when there is nothing to add.
export function describeConnectFailure(error: unknown, attempt: Attempt): string | undefined {
  if (!(error instanceof ApiError)) return undefined;

  // Field errors already print under the inputs they belong to.
  if (error.errors) return undefined;

  // An unrecognised reason — including one a newer backend invented — falls back to the
  // detail rather than leaving the user with a blank line.
  return describeFailureReason(error.reason, attempt) ?? error.message;
}
