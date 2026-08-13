import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Quiet defaults for the GETs any mounted panel makes; unhandled requests fail loudly.
const defaultHandlers = [
  http.get('/api/connection', () => HttpResponse.json({ state: 'Disconnected' })),
  http.get('/api/connection/settings', () => new HttpResponse(null, { status: 204 })),
  http.get('/api/subscriptions', () => HttpResponse.json([])),
  http.get('/api/colour-rules', () => HttpResponse.json({ rules: [] })),
];

export const server = setupServer(...defaultHandlers);
