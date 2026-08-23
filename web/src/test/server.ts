import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Quiet defaults for the GETs any mounted panel makes; unhandled requests fail loudly.
const defaultHandlers = [
  http.get('/api/connection', () => HttpResponse.json({ state: 'Disconnected' })),
  http.get('/api/connection/settings', () => new HttpResponse(null, { status: 204 })),
  http.get('/api/connection/profiles', () => HttpResponse.json([])),
  http.get('/api/subscriptions', () => HttpResponse.json([])),
  http.get('/api/colour-rules', () => HttpResponse.json({ rules: [] })),
  // A test host owns no window, so it offers no folder dialog — which is the browser's answer too.
  http.get('/api/export/folder', () => HttpResponse.json({ folder: null, canChoose: false })),
];

export const server = setupServer(...defaultHandlers);
