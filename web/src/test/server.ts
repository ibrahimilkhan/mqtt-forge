import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Quiet defaults for the GETs any mounted panel makes; unhandled requests fail loudly.
// Quiet defaults for the GETs any mounted panel makes; unhandled requests fail loudly.
const defaultHandlers = [
  http.get('/api/connection', () => HttpResponse.json({ state: 'Disconnected' })),
  http.get('/api/connection/settings', () => new HttpResponse(null, { status: 204 })),
  // A quiet supervisor: on, and nothing wrong. Tests about an outage override this.
  http.get('/api/connection/reconnect', () =>
    HttpResponse.json({
      enabled: true,
      active: false,
      attempt: 0,
      nextAttemptAt: null,
      gaveUp: false,
      now: new Date().toISOString(),
    }),
  ),
  http.get('/api/connection/profiles', () => HttpResponse.json([])),
  http.get('/api/subscriptions', () => HttpResponse.json([])),
  http.get('/api/colour-rules', () => HttpResponse.json({ rules: [] })),
  // Every mounted App reaches this through the hub bridge, which takes an alert snapshot as soon
  // as it subscribes. Written out in full rather than as {}: the store copies the snapshot member
  // by member, and a handler short of a member would have every panel test reading undefined.
  // `capped` is a list of capped rules, never a count — [...snapshot.capped] is what reads it.
  http.get('/api/alerts', () =>
    HttpResponse.json({
      active: [],
      history: [],
      muted: [],
      rules: [],
      dropped: 0,
      webhooksDropped: 0,
      suppressed: 0,
      capped: [],
      blindSeconds: 0,
      warming: [],
    }),
  ),
  // The alerts panel is the only reader, but a default keeps a mounted panel from failing on a
  // request it never asked about. A console with no rules is the honest quiet answer.
  http.get('/api/alert-rules', () =>
    HttpResponse.json({
      rules: [],
      allowWebhooks: false,
      topicPrefix: 'mqttforge/alerts/',
      unreadable: false,
      skippedIds: [],
    }),
  ),
  // A test host owns no window, so it offers neither dialog — which is the browser's answer too.
  http.get('/api/export/folder', () => HttpResponse.json({ folder: null, canChoose: false })),
  http.get('/api/connection/certificate-file', () => HttpResponse.json({ canChoose: false })),
];

export const server = setupServer(...defaultHandlers);
