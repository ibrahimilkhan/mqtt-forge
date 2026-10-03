// @ts-nocheck
/**
 * Not a test — a renderer, in the same spirit as gallery.render.test.tsx and for the same reason.
 *
 * The Flows page cannot be driven to the states worth a picture without a server running flows
 * and a broker under them: counts under every node, alarms standing on the Alarm node and on the
 * rail's badge, lines in the debug strip, an Activate the server refused. Here they are built out of
 * store state and the server's answers, rendered through the real console with the page open, and
 * written out as static pages — the whole console, as the gallery's console pages are, at the
 * README's window.
 *
 * `flows.html` is the watch at work, its Alarm node picked; `flows-simulator.html` the simulator
 * feeding it, its Publish picked; `flows-refused.html` a change to the watch the server refused.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, it, vi } from 'vitest';
import './styles/global.css';
import { App } from './App';
import { queryKeys } from './api/queryKeys';
import { forgetDrafts, standInForTheBrowser } from './features/flows/canvasTestbed';
import { exampleFlows } from './features/flows/examples';
import { NODE_WIDTH } from './features/flows/FlowCanvas';
import { useFlowDraftStore } from './features/flows/flowDraftStore';
import { createFakeHub } from './realtime/fakeHub';
import { useAlertStore } from './stores/alertStore';
import { useFlowStatusStore } from './stores/flowStatusStore';
import { server } from './test/server';

// The API's static root, found from this file's place in the checkout wherever that is.
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../src/MqttForge.Api/wwwroot');

/**
 * The canvas as the console draws it in the README's window, 1440 by 900, measured there in
 * Chrome: the workspace less the palette and the inspector across, and down, less the band, the
 * tabs, any line under them and the debug strip — which is why its height is each page's own.
 * React Flow fits the flow to this, and a canvas it took to be wider fitted the flow past its edge.
 */
const CANVAS_ACROSS = 715;

/** Reset for each page, to the height its canvas has in that window. */
let canvasDown = 540;

/**
 * A node as the browser lays it out: NODE_WIDTH across, and three lines down — its name, its
 * settings and its numbers, at the console's line height — with their padding and its frame. Chrome
 * draws it 71.52 high at the default type size, and every wire here meets its port to 0.02px.
 */
const NODE = { width: NODE_WIDTH, height: 71.5 };

/** A port's handle, as FlowCanvas.module.css draws it. */
const PORT = 10;

/**
 * Lends jsdom the canvas's layout, the way the gallery lends it a log's. jsdom lays nothing out,
 * and React Flow reads off the page the canvas's size, each node's, and where each port stands in
 * its node: without them the view is fitted to nothing, and every wire starts and ends at a
 * node's corner. With them, the wires this page bakes in meet the ports the browser lays out.
 *
 * A port stands on its node's edge, its middle on the edge of the node's padding, as far down it
 * as the share FlowCanvas writes on it. Places come back as the screen has them, at the view's
 * zoom, since React Flow takes the zoom back out.
 */
function laidOut() {
  const zoom = () => Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '')?.[1] ?? 1);
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  const canvas = (element) => ['react-flow', 'react-flow__renderer'].some((name) => element.classList?.contains(name));
  const sizeOf = (element) =>
    canvas(element)
      ? { width: CANVAS_ACROSS, height: canvasDown }
      : element.classList?.contains('react-flow__node')
        ? NODE
        : element.classList?.contains('react-flow__handle')
          ? { width: PORT, height: PORT }
          : null;

  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get() {
        return sizeOf(this)?.width ?? (Number.parseFloat(this.style.width) || 1);
      },
    },
    offsetHeight: {
      configurable: true,
      get() {
        return sizeOf(this)?.height ?? (Number.parseFloat(this.style.height) || 1);
      },
    },
  });

  const own = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const scale = zoom();
    if (canvas(this)) return box(0, 0, CANVAS_ACROSS, canvasDown);
    if (this.classList.contains('react-flow__node')) return box(0, 0, NODE.width * scale, NODE.height * scale);
    if (this.classList.contains('react-flow__handle')) {
      const across = this.dataset.handlepos === 'left' ? 1 : NODE.width - 1;
      const down = 1 + (Number.parseFloat(this.style.top) / 100) * (NODE.height - 2);
      return box((across - PORT / 2) * scale, (down - PORT / 2) * scale, PORT * scale, PORT * scale);
    }
    return own.call(this);
  };
}

/**
 * A ResizeObserver that reports as a browser does: once for all the elements it was handed in one
 * go, after they are laid out, rather than one at a time the moment each is handed over, as the
 * suite's stand-in does. React Flow fits the view to the nodes it has measured, and told of them
 * one by one it fitted the view to the first node alone.
 */
class Measured {
  constructor(callback) {
    this.callback = callback;
    this.waiting = [];
  }

  observe(target) {
    this.waiting.push(target);
    if (this.waiting.length > 1) return;

    queueMicrotask(() => {
      const targets = this.waiting.splice(0);
      this.callback(
        targets.map((target) => ({ target, contentRect: { width: target.offsetWidth, height: target.offsetHeight } })),
        this,
      );
    });
  }

  unobserve() {}
  disconnect() {}
}

/**
 * What React set as a property, written down as an attribute: the option a select is set to, and
 * the boxes and levels that are ticked. Serialised as they are, the page would open showing the
 * first option and nothing ticked — a flow set to run, drawn as one that is not.
 */
function stamp(root) {
  for (const select of root.querySelectorAll('select'))
    for (const option of select.options) {
      if (option.value === select.value) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    }

  for (const input of root.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
    if (input.checked) input.setAttribute('checked', '');
    else input.removeAttribute('checked');
  }

  return root;
}

/** The two examples, deployed, under ids a page can be read by. */
const [SIMULATOR, WATCH] = exampleFlows().map((flow, at) => ({ ...flow, id: ['simulator', 'watch'][at] }));

/** A moment the pages stand at, so a page rendered twice is the same page. */
const NOW = Date.parse('2026-09-27T09:14:22Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

/** The two alarms the watch holds up, as its Alarm node lists them and as the rail's badge counts them. */
const STANDING = [
  { topic: 'plant/k1/temp', firedAt: ago(6), reason: 'k1 is at 93.4 °C', count: 3 },
  { topic: 'plant/k3/temp', firedAt: ago(2), reason: 'k3 is at 91.8 °C', count: 1 },
];

/**
 * Ten minutes of both flows running: the simulator ticking every two seconds and publishing three
 * boilers' temperatures, and the watch hearing each one, a third of them over 90.
 */
const RUNNING = {
  runs: [
    {
      flowId: 'simulator', kind: 'active', state: 'waiting', at: null, waiting: null, fault: null, variables: {},
      nodes: [
        { id: 'tick', count: 300, outs: { out: 300 }, errors: 0, note: '["k1","k2","k3"]', standing: [] },
        { id: 'each', count: 300, outs: { out: 900 }, errors: 0, note: 'k3', standing: [] },
        { id: 'send', count: 900, outs: { sent: 900 }, errors: 0, note: '{"temp": 91.8}', standing: [] },
      ],
    },
    {
      flowId: 'watch', kind: 'active', state: 'waiting', at: null, waiting: null, fault: null, variables: {},
      nodes: [
        { id: 'in', count: 900, outs: { out: 900 }, errors: 0, note: '{"temp": 91.8}', standing: [] },
        { id: 'test', count: 900, outs: { yes: 312, no: 588 }, errors: 0, note: '91.8', standing: [] },
        { id: 'hot', count: 900, outs: { raised: 41, cleared: 39 }, errors: 0, note: 'k3 is at 91.8 °C', standing: STANDING },
        { id: 'fan', count: 312, outs: { sent: 312 }, errors: 0, note: '{"fan":"on"}', standing: [] },
        { id: 'say', count: 900, outs: {}, errors: 0, note: '{"temp": 91.8}', standing: [] },
      ],
    },
  ],
};

/** What the watch's Debug node printed in the last few seconds, oldest first, as a batch arrives. */
const PRINTED = [
  ['plant/k1/temp', 88.6], ['plant/k2/temp', 84.1], ['plant/k3/temp', 89.9],
  ['plant/k1/temp', 93.4], ['plant/k2/temp', 86.7], ['plant/k3/temp', 90.4],
  ['plant/k1/temp', 92.2], ['plant/k2/temp', 81.3], ['plant/k3/temp', 91.8],
].map(([topic, temp], at, all) => ({
  flowId: 'watch', nodeId: 'say', at: ago((all.length - at) * 0.7), kind: 'message', topic, text: `{"temp": ${temp}}`, test: false,
}));

/** The same two alarms as the rest of the console hears of them: warnings, from the flow's Alarm node. */
const ALARMS = STANDING.map((alarm, at) => ({
  id: `flow-alarm-${at + 1}`, ruleId: 'flow-watch-hot', ruleName: 'Boiler watch · Boiler too hot',
  topic: alarm.topic, severity: 'warn', firedAt: alarm.firedAt, lastSeenAt: ago(0),
  resolvedAt: null, resolvedBy: null, mutedUntil: null, count: alarm.count,
  reason: alarm.reason, value: Number(alarm.reason.match(/[\d.]+(?= °C)/)[0]), sample: null, actions: ['screen'],
}));

/** The refusal the server gives a Publish whose topic holds a wildcard. */
const REFUSED = { 'node:fan': ['A topic to publish to cannot hold + or #.'] };

/**
 * The server, answering as one running both examples would: the flows, their numbers, the alarms
 * and — for the refused page — an Activate of the watch it will not take. Each is also primed or seeded
 * where the console keeps it, and answered here too, because this page is not one synchronous pass:
 * the Flows page is a chunk of its own that has to arrive, and by then the console has asked.
 */
function answering() {
  server.use(
    http.get('/api/flows', () =>
      HttpResponse.json({ flows: [SIMULATOR, WATCH], problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/' }),
    ),
    http.get('/api/flows/status', () => HttpResponse.json(RUNNING)),
    http.get('/api/alerts', () =>
      HttpResponse.json({
        active: ALARMS, history: [], muted: [], rules: [], warming: [],
        dropped: 0, webhooksDropped: 0, suppressed: 0, capped: [], blindSeconds: 0,
      }),
    ),
    http.put('/api/flows/:id', () =>
      HttpResponse.json(
        { title: 'The flow was not deployed', detail: REFUSED['node:fan'][0], reason: 'flowInvalid', errors: REFUSED },
        { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    ),
  );
}

/**
 * The whole console with the Flows page open on one flow, one node picked, as one static page.
 * `down` is the height its canvas has at 1440 by 900, and `changing` an edit made to the flow before
 * the page opens, which is then activated: the examples are made switched off.
 */
async function console_(title, { flow, picked, down, changing = null }) {
  canvasDown = down;

  // Primed rather than fetched, and never fetched again: a console that asked would be answered
  // after the page had been written down.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.connection, {
    state: 'Connected',
    connection: {
      host: 'localhost', port: 1883, clientId: 'mqttforge', tls: false,
      connectedAt: '2026-09-27T08:58:10.000Z', subscriptions: 2, sessionPresent: false,
    },
  });
  client.setQueryData(queryKeys.colourRules, []);
  client.setQueryData(queryKeys.alertRules, { rules: [], topicPrefix: 'mqttforge/alerts/', allowWebhooks: true, unreadable: false, skippedIds: [] });
  client.setQueryData(queryKeys.flows, { flows: [SIMULATOR, WATCH], problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/' });

  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
  useFlowStatusStore.getState().setStatus(RUNNING);
  useFlowStatusStore.getState().addDebug(PRINTED, 0);
  useAlertStore.setState({ active: ALARMS });

  const drafts = useFlowDraftStore.getState();
  forgetDrafts();
  if (changing) drafts.edit(flow, changing);
  drafts.show(flow.id);
  drafts.select(picked);

  const view = render(
    <QueryClientProvider client={client}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );

  // The console opens on the Broker panel. The Flows page is a click away, and a static page
  // cannot carry one, so the click is made here — by the name at the head of the row, as the
  // gallery finds its rows.
  const menu = (name) =>
    [...view.container.querySelectorAll('nav[aria-label="Panels"] button')].find(
      (button) => button.querySelector('span')?.textContent === name,
    );
  act(() => fireEvent.click(menu('Broker')));
  act(() => fireEvent.click(menu('Flows')));

  // The page arrives as a chunk of its own, and the wires are drawn once the nodes are measured.
  await waitFor(() => {
    if (!view.container.querySelector('#flow-canvas .react-flow__edge-path')) throw new Error('The canvas has not drawn its wires yet.');
  });

  if (changing) {
    act(() => fireEvent.click(view.getByRole('button', { name: 'Activate' })));
    await view.findByText(/^The server refused/);
  }

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MQTTForge — ${title}</title>
${document.head.innerHTML}
</head><body>${stamp(view.container).innerHTML}</body></html>`;

  view.unmount();
  return html;
}

// Its own timeout, and a generous one, as the other renderers have: each page mounts the whole
// console and waits for a chunk to arrive, which on a busy machine is longer than five seconds.
const PATIENCE = 60_000;

beforeAll(() => {
  standInForTheBrowser();
  vi.stubGlobal('ResizeObserver', Measured);
  laidOut();
});
afterAll(() => vi.unstubAllGlobals());

it.skipIf(!existsSync(OUT))('writes the flows pages', async () => {
  answering();

  writeFileSync(`${OUT}/flows.html`, await console_('the flows', { flow: WATCH, picked: 'hot', down: 540 }));
  // No Debug node, so the strip under it is one line and the canvas taller.
  writeFileSync(`${OUT}/flows-simulator.html`, await console_('a simulator', { flow: SIMULATOR, picked: 'send', down: 699 }));
  writeFileSync(
    `${OUT}/flows-refused.html`,
    await console_('a refused Activate', {
      flow: WATCH,
      picked: 'fan',
      // The line under the tabs that says what the server refused takes its height from the canvas.
      down: 498,
      // A command for every boiler at once: a wildcard where a topic to publish to goes.
      changing: (flow) => ({
        ...flow,
        nodes: flow.nodes.map((node) => (node.id === 'fan' ? { ...node, config: { ...node.config, topic: 'plant/+/cmd' } } : node)),
      }),
    }),
  );
}, PATIENCE);
