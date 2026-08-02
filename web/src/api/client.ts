import { toApiError } from '../lib/problemDetails';

// Turns any non-2xx response into an ApiError so callers never branch on status codes.
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });

  if (!response.ok) throw await toApiError(response);

  // 202/204 responses carry nothing to parse.
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  return (isJson ? await response.json() : undefined) as T;
}

export const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
