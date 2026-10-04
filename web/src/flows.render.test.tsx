// @ts-nocheck
/**
 * Not a test — a renderer, in the same spirit as gallery.render.test.tsx and for the same reason.
 *
 * The Flows page cannot be driven to the states worth a picture without a server running flows
 * and a broker under them: a run waiting at a node, the numbers under every node, an alarm standing
 * on a Raise alarm and on the rail's badge, a notice in the corner, lines in the debug strip, an
 * Activate the server refused. Here they are built out of store state and the server's answers,
 * rendered through the real console with the page open, and written out as static pages — the
 * whole console, as the gallery's console pages are, at the README's window.
 *
 * `flows.html` is the watch at work with a test of it going, waiting at its MQTT in, its Raise alarm
 * picked; `flows-simulator.html` the simulator feeding it, waiting at its Wait, its Publish picked;
 * `flows-refused.html` a change to the watch the server would not activate.
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
import { forgetDrafts, runOf, standInForTheBrowser } from './features/flows/canvasTestbed';
import { exampleFlows } from './features/flows/examples';
import { DECISION_HEIGHT, DECISION_WIDTH, NODE_WIDTH, STEP_HEIGHT } from './features/flows/FlowCanvas';
import { useFlowDraftStore } from './features/flows/flowDraftStore';
import { createFakeHub } from './realtime/fakeHub';
import { useAlertStore } from './stores/alertStore';
import { useFlowStatusStore } from './stores/flowStatusStore';
import { useNoticeStore } from './stores/noticeStore';
import { server } from './test/server';

// The API's static root, found from this file's place in the checkout wherever that is.
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../src/MqttForge.Api/wwwroot');

/**
 * The canvas as the console draws it in the README's window, 1440 by 900, measured there in
 * Chrome: the workspace less the palette and the inspector across, and down, less the band, the
 * tabs, any line under them and the debug strip — which is why its height is each page's own.
 * React Flow fits the flow to this, and a canvas it took to be another size fitted the flow past
 * its edge, or into a corner of it.
 *
 * At this width every example is too wide to read fitted, so the canvas opens each at the least zoom
 * its text can be read at (see FlowCanvas): the simulator from its Start, whole; the watch on the node
 * picked — its Raise alarm, and on the refused page its Clear alarm — since from its Start that node
 * would be out of sight.
 */
const CANVAS_ACROSS = 715;

/** Reset for each page, to the height its canvas has in that window. */
let canvasDown = 562;

/**
 * A node the server refused says the first thing it was told under its name: one more line, of
 * --t-micro at the console's line height, which Chrome draws 16.26 high. The If keeps its own height
 * while its lines fit in it.
 */
const PROBLEM_LINE = 16.26;

/** A port's handle, as FlowCanvas.module.css draws it. */
const PORT = 10;

/** The shape of the node an element of the canvas belongs to: the node itself, or one of its ports. */
const shapeOf = (element) => element.closest('.react-flow__node')?.querySelector('[data-shape]')?.dataset.shape;

/**
 * A node as the browser lays it out, by its shape. A step, a pill, a parallelogram and a hexagon are
 * all NODE_WIDTH across and STEP_HEIGHT down, as Chrome draws them at the default type size; the If's
 * diamond is drawn in its own box, DECISION_WIDTH by DECISION_HEIGHT, with its three lines in the
 * middle of it.
 */
function boxOf(element) {
  const lines = STEP_HEIGHT + (element.closest('.react-flow__node')?.querySelector('[data-problem]') ? PROBLEM_LINE : 0);
  return shapeOf(element) === 'decision'
    ? { width: DECISION_WIDTH, height: Math.max(DECISION_HEIGHT, lines) }
    : { width: NODE_WIDTH, height: lines };
}

/**
 * Where a port's handle stands in its node, as FlowCanvas.module.css puts it (see sideOf): in the
 * middle of its side, its own middle on the edge of the node's padding, a pixel in from the frame —
 * and on the parallelogram's slanted sides, 5% of the way in, where they are at half the height.
 */
function portAt(handle) {
  const { width, height } = boxOf(handle);
  const slant = shapeOf(handle) === 'input' ? 0.05 * (width - 2) : 0;

  switch (handle.dataset.handlepos) {
    case 'left':
      return { across: 1 + slant, down: height / 2 };
    case 'right':
      return { across: width - 1 - slant, down: height / 2 };
    case 'top':
      return { across: width / 2, down: 1 };
    default:
      return { across: width / 2, down: height - 1 };
  }
}

/**
 * Lends jsdom the canvas's layout, the way the gallery lends it a log's. jsdom lays nothing out,
 * and React Flow reads off the page the canvas's size, each node's, and where each port stands in
 * its node: without them the view is fitted to nothing, and every wire starts and ends at a
 * node's corner, or nowhere. With them, the wires this page bakes in meet the ports the browser
 * lays out.
 *
 * Places come back as the screen has them, at the view's zoom, since React Flow takes the zoom back
 * out.
 */
function laidOut() {
  const zoom = () => Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.react-flow__viewport')?.style.transform ?? '')?.[1] ?? 1);
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  const canvas = (element) => ['react-flow', 'react-flow__renderer'].some((name) => element.classList?.contains(name));
  const sizeOf = (element) =>
    canvas(element)
      ? { width: CANVAS_ACROSS, height: canvasDown }
      : element.classList?.contains('react-flow__node')
        ? boxOf(element)
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
    if (this.classList.contains('react-flow__node')) {
      const { width, height } = boxOf(this);
      return box(0, 0, width * scale, height * scale);
    }
    if (this.classList.contains('react-flow__handle')) {
      const { across, down } = portAt(this);
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
 *
 * And again when an element changes its size, which a browser sees for itself and jsdom cannot:
 * the page calls `again` once a node has grown a line, and React Flow measures where its ports now
 * stand, or the wires would end where they stood before.
 */
class Measured {
  static watching = new Set();

  constructor(callback) {
    this.callback = callback;
    this.waiting = [];
    this.watched = new Set();
    Measured.watching.add(this);
  }

  static again() {
    for (const observer of Measured.watching) if (observer.watched.size > 0) observer.report([...observer.watched]);
  }

  report(targets) {
    this.callback(
      targets.map((target) => ({ target, contentRect: { width: target.offsetWidth, height: target.offsetHeight } })),
      this,
    );
  }

  observe(target) {
    this.watched.add(target);
    this.waiting.push(target);
    if (this.waiting.length > 1) return;

    queueMicrotask(() => this.report(this.waiting.splice(0)));
  }

  unobserve(target) {
    this.watched.delete(target);
  }

  disconnect() {
    this.watched.clear();
    Measured.watching.delete(this);
  }
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

/** The two examples, under ids a page can be read by. */
const [SIMULATOR, WATCH] = exampleFlows().map((flow, at) => ({ ...flow, id: ['simulator', 'watch'][at] }));

/** The flows as the server has them on a page: these switched on, the rest off. */
const served = (...on) => [SIMULATOR, WATCH].map((flow) => ({ ...flow, enabled: on.includes(flow.id) }));

/**
 * A moment the pages stand at, so a page rendered twice is the same page. The console's clock is
 * held there while they are drawn: a Wait counts down from it, and the debug strip tells its times
 * by it.
 */
const NOW = Date.parse('2026-09-27T09:14:22Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

/** One node's numbers, as a run reports them. */
const counted = (id, count, outs = {}, more = {}) => ({ id, count, outs, errors: 0, note: null, standing: [], ...more });

/**
 * The boiler that runs hot, as the watch's Raise alarm holds it up: the flow at work raised it a
 * couple of minutes ago and has seen it nine times since; a test keeps alarms of its own, and raised
 * its own the moment it read the same message, a moment ago.
 */
const K3 = { topic: 'plant/k3/temp', reason: 'k3 is at 91.8 °C' };
const STANDING_AT_WORK = [{ ...K3, firedAt: ago(140), count: 9 }];
const STANDING_IN_TEST = [{ ...K3, firedAt: ago(0.6), count: 1 }];

/**
 * Ten minutes of the simulator at work: a turn every two seconds, three boilers' temperatures
 * published in each, and the run waiting out its Wait, 1.4 s of it left.
 */
const SIMULATING = runOf('simulator', {
  state: 'waiting',
  at: 'tick',
  waiting: { until: new Date(NOW + 1400).toISOString(), filter: null },
  variables: { sensors: '["k1","k2","k3"]' },
  nodes: [
    counted('start', 1),
    counted('loop', 1, { body: 300 }),
    counted('each', 300, { body: 900, done: 300 }, { note: 'k3' }),
    counted('send', 900, { sent: 900 }, { note: '{"temp": 91.8}' }),
    counted('tick', 300, { out: 299 }),
    counted('end', 0),
  ],
});

/**
 * The watch at work for as long, a third of what it read over 90 — and a test of it, which has read
 * one message, k3 at 91.8, gone the whole way round, and waits at the MQTT in for the next. The
 * canvas shows the test while it goes.
 */
const WATCHING = runOf('watch', {
  state: 'waiting',
  at: 'read',
  waiting: { until: null, filter: 'plant/+/temp' },
  variables: { limit: '90' },
  nodes: [
    counted('start', 1),
    counted('loop', 1, { body: 901 }),
    counted('read', 900, { out: 900 }, { note: '{"temp": 91.8}' }),
    counted('say', 900, { out: 900 }),
    counted('test', 900, { yes: 312, no: 588 }, { note: '91.8' }),
    counted('hot', 312, { raised: 41, up: 271 }, { note: 'k3 is at 91.8 °C', standing: STANDING_AT_WORK }),
    counted('beep', 41, { played: 41, out: 41 }),
    counted('tell', 41, { shown: 41, out: 41 }),
    counted('fan', 41, { sent: 41, out: 41 }, { note: '{"fan":"on"}' }),
    counted('cool', 588, { cleared: 40, none: 548 }),
    counted('end', 0),
  ],
});

const TESTING = runOf('watch', {
  kind: 'test',
  state: 'waiting',
  at: 'read',
  waiting: { until: null, filter: 'plant/+/temp' },
  variables: { limit: '90' },
  nodes: [
    counted('start', 1),
    counted('loop', 1, { body: 2 }),
    counted('read', 1, { out: 1 }, { note: '{"temp": 91.8}' }),
    counted('say', 1, { out: 1 }),
    counted('test', 1, { yes: 1, no: 0 }, { note: '91.8' }),
    counted('hot', 1, { raised: 1, up: 0 }, { note: 'k3 is at 91.8 °C', standing: STANDING_IN_TEST }),
    counted('beep', 1, { played: 1, out: 1 }),
    counted('tell', 1, { shown: 1, out: 1 }),
    counted('fan', 1, { sent: 1, out: 1 }, { note: '{"fan":"on"}' }),
    counted('cool', 0),
    counted('end', 0),
  ],
});

/**
 * What the watch's Debug node printed in the last few seconds, oldest first, as a batch arrives: the
 * flow at work's lines, and last the test's one line — the same message as the line before it, which
 * both runs read — marked as the test's.
 */
const AT_WORK = [
  ['plant/k1/temp', 88.6], ['plant/k2/temp', 84.1], ['plant/k3/temp', 89.9],
  ['plant/k1/temp', 89.4], ['plant/k2/temp', 86.7], ['plant/k3/temp', 91.8],
].map(([topic, temp], at, all) => ({
  flowId: 'watch', nodeId: 'say', at: ago((all.length - at) * 0.6), kind: 'message', topic, text: `{"temp": ${temp}}`, test: false,
}));
const PRINTED = [...AT_WORK, { ...AT_WORK.at(-1), test: true }];

/** The alarms as the rest of the console hears of them: the flow at work's, and the test's own. */
const ALARMS = [
  { ruleId: 'flow-watch-hot', ruleName: 'Boiler watch · Boiler too hot', standing: STANDING_AT_WORK[0] },
  { ruleId: 'flowtest-watch-hot', ruleName: 'Boiler watch · Boiler too hot (test)', standing: STANDING_IN_TEST[0] },
].map(({ ruleId, ruleName, standing }, at) => ({
  id: `flow-alarm-${at + 1}`, ruleId, ruleName,
  topic: standing.topic, severity: 'warn', firedAt: standing.firedAt, lastSeenAt: ago(1),
  resolvedAt: null, resolvedBy: null, mutedUntil: null, count: standing.count,
  reason: standing.reason, value: 91.8, sample: null, actions: ['screen'],
}));

/** What the test's Notify said when it raised its alarm, standing in the corner of the console. */
const NOTICE = {
  flowId: 'watch', flowName: 'Boiler watch', nodeId: 'tell', text: 'k3 is at 91.8 °C', level: 'warn', at: ago(0.6), test: true,
};

/** The refusal the server gives a Clear alarm that names no Raise alarm to close. */
const REFUSED = { 'node:cool': ['Pick the alarm this clears.'] };

/**
 * The server, answering as one running the flows a page has would: the flows, their numbers, the
 * alarms and — for the refused page — an Activate it will not take. Each is also primed or seeded
 * where the console keeps it, and answered here too, because this page is not one synchronous pass:
 * the Flows page is a chunk of its own that has to arrive, and by then the console has asked.
 */
function answering({ flows, status, alarms }) {
  server.use(
    http.get('/api/flows', () =>
      HttpResponse.json({ flows, problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/' }),
    ),
    http.get('/api/flows/status', () => HttpResponse.json(status)),
    http.get('/api/alerts', () =>
      HttpResponse.json({
        active: alarms, history: [], muted: [], rules: [], warming: [],
        dropped: 0, webhooksDropped: 0, suppressed: 0, capped: [], blindSeconds: 0,
      }),
    ),
    http.put('/api/flows/:id', () =>
      HttpResponse.json(
        { title: 'The flow was not deployed', detail: REFUSED['node:cool'][0], reason: 'flowInvalid', errors: REFUSED },
        { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    ),
  );
}

/**
 * The whole console with the Flows page open on one flow, one node picked, as one static page.
 * `down` is the height its canvas has at 1440 by 900; `flows` the server's copies, switched on or
 * off; `status` the runs it reports; `printed` and `alarms` what the debug strip and the rail hold;
 * `notice` one standing in the corner; and `changing` an edit made to the flow before the page
 * opens, which is then activated.
 */
async function console_(title, { flow, picked, down, flows, status, printed = [], alarms = [], notice = null, changing = null }) {
  canvasDown = down;
  answering({ flows, status, alarms });

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
  client.setQueryData(queryKeys.flows, { flows, problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/' });

  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
  useFlowStatusStore.getState().setStatus(status);
  useFlowStatusStore.getState().addDebug(printed, 0);
  useAlertStore.setState({ active: alarms });
  useNoticeStore.setState(useNoticeStore.getInitialState());

  const drafts = useFlowDraftStore.getState();
  forgetDrafts();
  if (changing) drafts.edit(flows.find((one) => one.id === flow.id), changing);
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

  // The node refused says so under its name, and is a line taller for it.
  if (changing) {
    act(() => fireEvent.click(view.getByRole('button', { name: 'Activate' })));
    await view.findByText(/^The server refused/);
    act(() => Measured.again());
  }

  // Last, just before the page is written down: a notice goes by itself after eight seconds, and a
  // page that took longer than that to draw would have lost it.
  if (notice) act(() => useNoticeStore.getState().add([notice]));

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
  // Only the date: the console's timers still run, so the page arrives and draws as it would.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.skipIf(!existsSync(OUT))('writes the flows pages', async () => {
  writeFileSync(
    `${OUT}/flows.html`,
    await console_('the flows', {
      flow: WATCH,
      picked: 'hot',
      down: 562,
      flows: served('simulator', 'watch'),
      status: { runs: [SIMULATING, WATCHING, TESTING] },
      printed: PRINTED,
      alarms: ALARMS,
      notice: NOTICE,
    }),
  );

  // No Debug node, so the strip under it is one line and the canvas taller.
  writeFileSync(
    `${OUT}/flows-simulator.html`,
    await console_('a simulator', {
      flow: SIMULATOR,
      picked: 'send',
      down: 699,
      flows: served('simulator', 'watch'),
      status: { runs: [SIMULATING, WATCHING] },
      alarms: [ALARMS[0]],
    }),
  );

  writeFileSync(
    `${OUT}/flows-refused.html`,
    await console_('a refused Activate', {
      flow: WATCH,
      picked: 'cool',
      // The line under the tabs that says what the server refused takes its height from the canvas.
      down: 657,
      // Switched off, so Activate is what saves the change and switches it on.
      flows: served('simulator'),
      status: { runs: [SIMULATING] },
      // A Clear alarm that closes nothing: its Raise alarm unpicked.
      changing: (flow) => ({
        ...flow,
        nodes: flow.nodes.map((node) => (node.id === 'cool' ? { ...node, config: { ...node.config, alarm: '' } } : node)),
      }),
    }),
  );
}, PATIENCE);
