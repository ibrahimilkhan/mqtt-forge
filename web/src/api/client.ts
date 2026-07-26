import { toApiError } from '../lib/problemDetails';

// The single place a request leaves the app. Anything other than 2xx becomes an ApiError,
// so callers never branch on status codes.
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });

  if (!response.ok) throw await toApiError(response);

  // 202 Accepted and 204 No Content carry nothing to parse.
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  return (isJson ? await response.json() : undefined) as T;
}

export const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
