import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import type { FlowDto } from '../types/api';
import { deleteFlow, injectNode, isFlowInvalid, putFlow } from './flows';

const flow: FlowDto = { id: 'watch', name: 'Boiler watch', enabled: true, nodes: [], edges: [] };

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

  it('deletes and injects with nothing to read back', async () => {
    server.use(
      http.delete('/api/flows/watch', () => new HttpResponse(null, { status: 204 })),
      http.post('/api/flows/watch/nodes/go/inject', () => new HttpResponse(null, { status: 202 })),
    );

    await expect(deleteFlow('watch')).resolves.toBeUndefined();
    await expect(injectNode('watch', 'go')).resolves.toBeUndefined();
  });
});
