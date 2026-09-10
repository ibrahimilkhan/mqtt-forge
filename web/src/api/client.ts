import { ApiError, toApiError } from '../lib/problemDetails';

/**
 * How long a request waits for the console's own server before giving up on it.
 *
 * Not a guess about a slow network: every one of these goes to a server on this machine or on the
 * LAN, and the ones that take a long time take it because something at the far end is waiting —
 * see `patient` below, which is how those say so. Fifteen seconds is past anything healthy.
 *
 * `fetch` has no timeout of its own, and a server that accepts the connection and then answers
 * nothing — one paused by the operating system, one whose host went to sleep, a proxy holding the
 * socket open — leaves the promise pending for the life of the tab. That is what the Disconnect
 * button did while the console had lost its server: pressed, disabled, and disabled for ever,
 * with nothing anywhere saying why.
 */
export const PATIENCE_MS = 15_000;

/** For the two calls that are waiting on something other than the server's own speed. */
export type Patience = { timeoutMs: number };

// Turns any non-2xx response into an ApiError so callers never branch on status codes.
export async function request<T>(
  path: string,
  init?: RequestInit,
  patience: Patience = { timeoutMs: PATIENCE_MS },
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    signal: waitNoLongerThan(patience.timeoutMs, init?.signal),
  }).catch((thrown: unknown) => {
    // An abort here is this timeout and not a caller's: nothing in the console passes a signal of
    // its own. Said as an ApiError like every other failure, so the panel that reports it has one
    // shape to read rather than two.
    //
    // Read off the name rather than with `instanceof DOMException`: the exception is raised by
    // the fetch implementation, which in a test runner is a different realm from this module's,
    // and an `instanceof` across two realms is false however right it looks.
    if ((thrown as { name?: unknown } | null)?.name === 'TimeoutError')
      throw new ApiError(0, 'The console’s own server did not answer.', 'No answer');

    throw thrown;
  });

  if (!response.ok) throw await toApiError(response);

  // 202/204 responses carry nothing to parse.
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  return (isJson ? await response.json() : undefined) as T;
}

/**
 * The caller's own signal where there is one, and the timeout either way.
 *
 * `AbortSignal.any` is what combines them; a runtime without it — an old WebView, a test
 * environment — gets the timeout alone rather than an exception, since a request that cannot be
 * cancelled early is a great deal better than a request that cannot be made.
 */
function waitNoLongerThan(ms: number, own: AbortSignal | null | undefined): AbortSignal | undefined {
  if (typeof AbortSignal?.timeout !== 'function') return own ?? undefined;

  const bound = AbortSignal.timeout(ms);
  if (!own) return bound;

  return typeof AbortSignal.any === 'function' ? AbortSignal.any([own, bound]) : bound;
}

export const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
