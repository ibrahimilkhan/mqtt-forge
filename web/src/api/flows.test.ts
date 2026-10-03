import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import type { FlowDto } from '../types/api';
import { deleteFlow, isFlowInvalid, isTestUnknown, putFlow, stopTest, testFlow } from './flows';

const flow: FlowDto = { id: 'watch', name: 'Boiler watch', enabled: true, nodes: [], edges: [], variables: [] };

describe('flows client', () => {
  it('puts a flow at its own address and reads back what was kept', async () => {
    let seen: unknown;
    server.use(
      http.put('/api/flows/watch', async ({ request }) => {
        seen = await request.json();
        return HttpResponse.json({ flow });
      }),
    );

    await expect(putFlow(flow)).resolves.toEqual({ flow });
    expect(seen).toEqual(flow);
  });

  it('knows a refused deploy by its reason, and carries what was said about each node', async () => {
    server.use(
      http.put('/api/flows/watch', () =>
        HttpResponse.json(
          {
            title: 'The flow was not deployed',
            detail: 'Pick a test.',
            reason: 'flowInvalid',
            errors: { 'node:n2': ['Pick a test.'] },
          },
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const error = await putFlow(flow).catch((thrown: unknown) => thrown);

    expect(isFlowInvalid(error)).toBe(true);
    expect(isFlowInvalid(error) && error.errors).toEqual({ 'node:n2': ['Pick a test.'] });
  });

  it('deletes with nothing to read back', async () => {
    server.use(http.delete('/api/flows/watch', () => new HttpResponse(null, { status: 204 })));

    await expect(deleteFlow('watch')).resolves.toBeUndefined();
  });

  it('sends a test as the flow, to its own address, and takes the 202', async () => {
    let sent: unknown = null;
    server.use(
      http.post('/api/flows/watch/test', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    await testFlow(flow);

    expect(sent).toEqual(flow);
  });

  // A test is refused for what is in the draft, exactly as a save is, so the page marks the nodes
  // from the same answer and reads it with the same check.
  it('knows a refused test the way it knows a refused save', async () => {
    server.use(
      http.post('/api/flows/watch/test', () =>
        HttpResponse.json(
          {
            title: 'The flow was not tested',
            detail: 'Pick a test.',
            reason: 'flowInvalid',
            errors: { 'node:n2': ['Pick a test.'] },
          },
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const error = await testFlow(flow).catch((thrown: unknown) => thrown);

    expect(isFlowInvalid(error)).toBe(true);
    expect(isFlowInvalid(error) && error.errors).toEqual({ 'node:n2': ['Pick a test.'] });
  });

  it('tells a test that is not going from any other failure to stop one', async () => {
    server.use(
      http.delete('/api/flows/watch/test', () =>
        HttpResponse.json(
          { title: 'No test', detail: "Flow 'watch' has no test going.", reason: 'testUnknown' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    const error = await stopTest('watch').catch((caught: unknown) => caught);

    expect(isTestUnknown(error)).toBe(true);
  });

  // Only the server's own 404, the one that says so, means the test had already ended. A 404 from a
  // proxy with no such address, one that names a flow the server does not have, and a server that fell
  // over are failures to stop a test — and a console that took them for a test that had ended would say
  // nothing was wrong.
  it('does not take any other failure to stop a test for one that was not going', async () => {
    server.use(
      http.delete('/api/flows/watch/test', () =>
        HttpResponse.json(
          { title: 'No flow', detail: "There is no flow 'watch'.", reason: 'flowUnknown' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
      http.delete('/api/flows/sim/test', () => new HttpResponse(null, { status: 404 })),
      http.delete('/api/flows/fan/test', () => HttpResponse.json({ title: 'Server error' }, { status: 500 })),
    );

    for (const id of ['watch', 'sim', 'fan']) {
      const error = await stopTest(id).catch((caught: unknown) => caught);

      expect(isTestUnknown(error)).toBe(false);
    }
  });

  it('stops a test with nothing to read back', async () => {
    server.use(http.delete('/api/flows/watch/test', () => new HttpResponse(null, { status: 204 })));

    await expect(stopTest('watch')).resolves.toBeUndefined();
  });
});
