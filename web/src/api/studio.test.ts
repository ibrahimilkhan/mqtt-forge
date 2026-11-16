import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { blankScene } from '../features/studio/model/defaults';
import { server } from '../test/server';
import { deleteScene, getScene, isSceneUnknown, listScenes, putScene, uploadModel } from './studio';

describe('studio api', () => {
  it('lists, reads, saves and deletes scenes at their own addresses', async () => {
    const scene = blankScene('Cell');
    let saved: unknown;
    server.use(
      http.get('/api/studio/scenes', () => HttpResponse.json([{ id: scene.id, name: 'Cell', updatedAt: scene.updatedAt }])),
      http.get(`/api/studio/scenes/${scene.id}`, () => HttpResponse.json(scene)),
      http.put(`/api/studio/scenes/${scene.id}`, async ({ request }) => {
        saved = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`/api/studio/scenes/${scene.id}`, () => new HttpResponse(null, { status: 204 })),
    );

    expect(await listScenes()).toEqual([{ id: scene.id, name: 'Cell', updatedAt: scene.updatedAt }]);
    expect(await getScene(scene.id)).toEqual(scene);
    await putScene(scene);
    expect(saved).toEqual(scene);
    await expect(deleteScene(scene.id)).resolves.toBeUndefined();
  });

  it('sends a model as raw bytes with its extension in the query', async () => {
    let seen: { ext: string | null; type: string | null; bytes: Uint8Array } | undefined;
    server.use(
      http.post('/api/studio/models', async ({ request }) => {
        seen = {
          ext: new URL(request.url).searchParams.get('ext'),
          type: request.headers.get('content-type'),
          bytes: new Uint8Array(await request.arrayBuffer()),
        };
        return HttpResponse.json({ key: 'k.stl' });
      }),
    );

    const bytes = new Uint8Array([0, 0xff, 0xfe, 0x80, 0x41]);
    expect(await uploadModel(new Blob([bytes]), '.stl')).toEqual({ key: 'k.stl' });
    expect(seen?.ext).toEqual('.stl');
    expect(seen?.type).toEqual('application/octet-stream');
    expect(seen?.bytes).toEqual(bytes);
  });

  it('tells a scene that is not there apart from other failures', async () => {
    server.use(
      http.get('/api/studio/scenes/gone', () =>
        HttpResponse.json({ status: 404, title: 'No scene', reason: 'sceneUnknown' }, { status: 404 })),
    );

    await expect(getScene('gone')).rejects.toSatisfy(isSceneUnknown);
  });
});
