import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/problemDetails';
import { server } from '../test/server';
import { connect, disconnect, getConnectionState, getSavedSettings } from './connection';
import { subscribe, unsubscribe } from './subscriptions';

describe('api client', () => {
  it('returns the parsed body of a successful request', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

    await expect(getConnectionState()).resolves.toEqual({ state: 'Connected' });
  });

  it('returns undefined for the 204 the settings endpoint sends when nothing is saved', async () => {
    server.use(http.get('/api/connection/settings', () => new HttpResponse(null, { status: 204 })));

    await expect(getSavedSettings()).resolves.toBeUndefined();
  });

  it('turns a failure into an ApiError carrying the ProblemDetails message', async () => {
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json({ title: 'Broker unreachable', detail: 'Connection refused' }, { status: 502 }),
      ),
    );

    const error = await connect({
      host: 'localhost',
      port: 1883,
      clientId: 'id',
      username: null,
      password: null,
      useTls: false,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, message: 'Connection refused', title: 'Broker unreachable' });
  });

  it('sends the topic filter as a query value, since wildcards cannot travel in a path', async () => {
    let requested: string | undefined;
    server.use(
      http.delete('/api/subscriptions', ({ request }) => {
        requested = new URL(request.url).searchParams.get('topicFilter') ?? undefined;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await unsubscribe('sensors/#');

    expect(requested).toBe('sensors/#');
  });

  it('posts a JSON body with the content type the API expects', async () => {
    let body: unknown;
    let contentType: string | null = null;
    server.use(
      http.post('/api/subscriptions', async ({ request }) => {
        contentType = request.headers.get('content-type');
        body = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    await subscribe({ topicFilter: 'sensors/#', qos: 1 });

    expect(contentType).toContain('application/json');
    expect(body).toEqual({ topicFilter: 'sensors/#', qos: 1 });
  });

  it('resolves for a 204 with no body', async () => {
    server.use(http.delete('/api/connection', () => new HttpResponse(null, { status: 204 })));

    await expect(disconnect()).resolves.toBeUndefined();
  });
});
