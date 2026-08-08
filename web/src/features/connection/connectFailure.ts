import { ApiError } from '../../lib/problemDetails';

type Attempt = { host: string; port: number; clientId: string };

// The backend classifies the failure; the wording lives here, next to the panel that shows it.
const SENTENCE: Record<string, (attempt: Attempt) => string> = {
  refused: ({ host, port }) => `Nothing is listening at ${host}:${port}.`,
  hostNotFound: ({ host }) => `No host named ${host}.`,
  unreachable: ({ host }) => `${host} can't be reached from this machine.`,
  timeout: ({ host, port }) => `${host}:${port} didn't respond in time.`,
  tlsFailed: ({ host }) => `TLS handshake with ${host} failed.`,
  credentialsRejected: () => 'The broker rejected the username or password.',
  clientIdRejected: ({ clientId }) => `The broker rejected the client ID '${clientId}'.`,
  brokerBusy: () => 'The broker is unavailable or too busy right now.',
};

// One line explaining why a connect attempt failed, or nothing when there is nothing to add.
export function describeConnectFailure(error: unknown, attempt: Attempt): string | undefined {
  if (!(error instanceof ApiError)) return undefined;

  // Field errors already print under the inputs they belong to.
  if (error.errors) return undefined;

  // An unrecognised reason — including one a newer backend invented — falls back to the
  // detail rather than leaving the user with a blank line.
  return (error.reason && SENTENCE[error.reason]?.(attempt)) ?? error.message;
}
