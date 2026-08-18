// @ts-nocheck
/**
 * Not a test — a renderer.
 *
 * The console cannot be driven to every state by hand in a browser: a pulse train, a counter that
 * wraps, a branch of six topics and a payload that is not a number would each need a broker and a
 * device behind it. Here the states are built out of log entries directly, rendered through the
 * real components, and written out as one page. What it writes is the real thing — the CSS
 * modules are compiled in this environment — so it can be looked at rather than reasoned about.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { it } from 'vitest';
import './styles/global.css';
import { App } from './App';
import { MARKS } from './features/brand/marks';
import { TrafficChart } from './features/monitor/TrafficChart';
import { queryKeys } from './api/queryKeys';
import { createFakeHub } from './realtime/fakeHub';
import { useAppearanceStore } from './stores/appearanceStore';
import { useLogStore } from './stores/logStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTopicTreeStore } from './stores/topicTreeStore';

const OUT = '/Users/ilkhan/RiderProjects/MqttForge/src/MqttForge.Api/wwwroot';

/** Three runs a page: one screenshot's worth, and no page that has to be scrolled to be read. */
const PER_PAGE = 3;

let id = 0;
const entries = (topic: string, bodies: string[], everyMs = 1000) =>
  bodies
    .map((body, index) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(Date.UTC(2026, 7, 19, 9, 0, 0) + index * everyMs),
      topic,
      body,
      mode: 'text' as const,
    }))
    .reverse();

const repeat = (times: number, ...pattern: string[]) =>
  Array.from({ length: times * pattern.length }, (_, i) => pattern[i % pattern.length]);

const wobble = (n: number, base: number, swing: number) =>
  Array.from({ length: n }, (_, i) =>
    (base + Math.sin(i / 4) * swing + ((i * 37) % 11) / 11 - 0.5).toFixed(2),
  );

const RUNS = [
  {
    name: 'A quantity, with one wild reading in it',
    note: "The brief's own case: 1, 2, 3 all day and then 4000. Left, scaled to the extremes — the thousand readings share the bottom pixel. Right, scaled to the middle of the run, with the spike pinned to the top edge and counted.",
    both: true,
    log: entries('sensors/room/temp', [...repeat(20, '1', '2', '3'), '4000']),
  },
  {
    name: 'A quantity behaving itself',
    note: 'A run with a swing and noise on it. The band is one deviation either side of the mean, and the fences ring what falls outside them.',
    log: entries('sensors/room/temp', wobble(90, 21.5, 2.4)),
  },
  {
    name: 'A switch',
    note: 'Two levels. Drawn as steps, because a door does not pass through the values between shut and open. No mean, no deviation, no trend — events, duty, width and period, and the line they were counted against.',
    log: entries('sensors/door/state', repeat(6, '0', '0', '0', '0', '1', '1', '0', '1', '1', '1')),
  },
  {
    name: 'A pulse train',
    note: 'A rest with events on it. Kept on its extremes whatever the setting says: a pulse clipped to its typical range is the signal shaved off the top.',
    log: entries('sensors/flow/rate', [
      ...repeat(8, '1', '2', '3'), '900', '880',
      ...repeat(6, '1', '2', '3'), '910',
      ...repeat(6, '2', '1', '3'), '895', '870',
      ...repeat(5, '1', '2', '3'),
    ]),
  },
  {
    name: 'A running total',
    note: 'The value only says when the device last restarted, so the note reads the rate instead. A restart is allowed for and counted.',
    log: entries(
      'gateway/packets',
      [0, 5, 9, 2, 12, 0, 8, 3, 15, 6, 1, 9, 4, 11, 7, 2, 10, 5, 8, 4, 13, 6]
        .reduce((run, burst) => [...run, run[run.length - 1] + burst], [40218])
        .map(String),
    ),
  },
  {
    name: 'A branch of the tree',
    note: 'Several topics at once — until now the commonest way to get no chart at all. One plot per topic on its own scale, since °C and % share no axis but do share a moment. Clicking a row narrows the pane to that topic.',
    log: [
      ...entries('sensors/room/temp', wobble(40, 21.5, 1.2)),
      ...entries('sensors/room/humidity', wobble(40, 54, 6)),
      ...entries('sensors/room/pressure', wobble(40, 1013, 3)),
      ...entries('sensors/room/battery', wobble(40, 3.71, 0.04)),
    ],
  },
  {
    name: 'Nothing to draw: the bodies are not numbers',
    note: "It used to say 'a line needs one topic sending numbers' for this and for three other situations. Now it names the reason and puts the topic's own newest message under it as evidence.",
    log: entries('sensors/door/state', ['{"state":"OPEN","by":"kitchen"}', '{"state":"SHUT","by":"kitchen"}']),
  },
  {
    name: 'Nothing to draw: the run is one message old',
    note: 'Temporary, and it says so. The old sentence read like a refusal.',
    log: entries('sensors/room/temp', ['21.5']),
  },
  {
    name: 'A topic that mostly sends something else',
    note: 'Refused outright before. Two readings are a line, and the note says in the fault colour how much of the run had to be stepped over.',
    log: entries('sensors/kiln/temp', ['840', 'warming up', 'warming up', 'warming up', 'warming up', 'warming up', '1180']),
  },
];

function Framed({ children }) {
  return <div className="gPane">{children}</div>;
}

// Written into the API's static root, which is where a browser can reach it. Absent before the
// web app has been built at least once, and there is nothing to serve it from then either.
it.skipIf(!existsSync(OUT))('writes the gallery', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const marks = (
    <div className="gMarks">
      {Object.entries(MARKS).map(([mid, mark]) => (
        <figure key={mid} className="gMark">
          <div className="gMarkRow">
            <span style={{ fontSize: 44, lineHeight: 0 }}>{mark.draw()}</span>
            <span style={{ fontSize: 26, lineHeight: 0 }}>{mark.draw()}</span>
            <span style={{ fontSize: 16, lineHeight: 0 }}>{mark.draw()}</span>
          </div>
          <div className="gRail">
            <span style={{ fontSize: 22, lineHeight: 0 }}>{mark.draw()}</span>
            <b className="gWord">
              MQTT<span>Forge</span>
            </b>
          </div>
          <figcaption>
            <b>{mark.label}</b>
            <span>{mark.about}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );

  const pages = [];
  for (let at = 0; at < RUNS.length; at += PER_PAGE) pages.push(RUNS.slice(at, at + PER_PAGE));

  const drawn = pages.map((page) =>
    page
      .map((run) => {
        useLogStore.getState().clear();

        const draw = (scale) => {
          useAppearanceStore.setState({ scale });
          const { container, unmount } = render(
            <QueryClientProvider client={client}>
              <Framed>
                <TrafficChart entries={run.log} />
              </Framed>
            </QueryClientProvider>,
          );
          const html = container.innerHTML;
          unmount();

          return html;
        };

        return `
      <section class="gRun">
        <h3>${run.name}</h3>
        <p>${run.note}</p>
        <div class="gRow">
          ${run.both ? `<div class="gCell"><span class="gTag">ends</span>${draw('extremes')}</div>` : ''}
          <div class="gCell"><span class="gTag">${run.both ? 'mid' : 'default'}</span>${draw('typical')}</div>
        </div>
      </section>`;
      })
      .join(''),
  );

  const { container: markBox } = render(
    <QueryClientProvider client={client}>{marks}</QueryClientProvider>,
  );

  const STYLE = `<style>
  body { display:block; height:auto; padding: 36px clamp(16px, 5vw, 64px) 72px; }
  h1 { font-family: var(--mono); font-size: 26px; letter-spacing:-0.03em; margin: 0 0 6px; }
  h2 { font-family: var(--mono); font-size: 15px; letter-spacing:0.14em; text-transform:uppercase;
       color: var(--muted); margin: 40px 0 14px; padding-bottom: 8px; border-bottom:1px solid var(--rule); }
  h3 { font-family: var(--mono); font-size: 14px; margin: 0 0 4px; }
  .gLede { color: var(--muted); max-width: 62ch; margin: 0 0 8px; }
  .gNav { display:flex; gap:14px; flex-wrap:wrap; margin: 14px 0 0; font-family: var(--mono); font-size:12px; }
  .gNav a { color: var(--signal); }
  .gRun { margin: 0 0 30px; }
  .gRun > p { color: var(--muted); font-size: 13.5px; max-width: 80ch; margin: 0 0 12px; }
  .gRow { display:flex; flex-wrap: wrap; gap: 18px; }
  .gCell { position: relative; }
  .gTag { position:absolute; top:-9px; left:10px; z-index:1; background: var(--paper);
          font-family: var(--mono); font-size: 10px; letter-spacing:.1em; color: var(--muted); padding: 0 5px; }
  .gPane { width: 460px; height: 250px; display:grid; grid-template-rows: minmax(0,1fr);
           background: var(--surface); border:1px solid var(--rule); border-radius:3px; padding: 10px 16px 14px; }
  .gMarks { display:grid; grid-template-columns: repeat(auto-fill, minmax(240px,1fr)); gap: 18px; }
  .gMark { margin:0; background: var(--surface); border:1px solid var(--rule); border-radius:3px; padding:18px 18px 14px; }
  .gMarkRow { display:flex; align-items:flex-end; gap:20px; height:56px; color: var(--ink); }
  .gRail { display:flex; align-items:center; gap:8px; margin-top:16px; padding:8px 10px;
           background: var(--paper); border:1px solid var(--rule); border-radius:2px; color: var(--ink); }
  .gWord { font-family: var(--mono); font-size:17px; letter-spacing:-0.03em; }
  .gWord span { color: var(--signal); }
  .gMark figcaption { margin-top:14px; display:flex; flex-direction:column; gap:3px; }
  .gMark figcaption b { font-family: var(--mono); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
  .gMark figcaption span { color: var(--muted); font-size:12.5px; line-height:1.45; }
</style>`;

  const nav = ['gallery.html', ...pages.map((_, i) => `gallery-${i + 1}.html`)]
    .map((href, i) => `<a href="${href}">${i === 0 ? 'Marks' : `Charts ${i}`}</a>`)
    .join('');

  const page = (title, inner) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MQTTForge — ${title}</title>
${document.head.innerHTML}
${STYLE}
</head><body>
<h1>MQTT<span style="color:var(--signal)">Forge</span></h1>
<p class="gLede">Six marks to choose between, and the chart in every state the brief asked about.
Rendered through the console's own components, so what is below is what the tool draws.</p>
<nav class="gNav">${nav}</nav>
${inner}
</body></html>`;

  writeFileSync(
    `${OUT}/gallery.html`,
    page('marks', `<h2>Marks — pick one</h2>${markBox.innerHTML}`),
  );

  drawn.forEach((inner, i) =>
    writeFileSync(`${OUT}/gallery-${i + 1}.html`, page(`charts ${i + 1}`, `<h2>The chart</h2>${inner}`)),
  );

  writeFileSync(`${OUT}/console.html`, console_(client));
});

/**
 * The whole console with traffic in it, as one static page.
 *
 * The screenshots in the README were taken against a live broker, and there is not one here. The
 * console does not need one to be looked at: the log, the tree and the selection are stores, and
 * a fake hub satisfies the bridge. What this writes is the real layout with real components in
 * it, at whatever size the window opens — which is what a screenshot of the console is.
 */
function console_(client) {
  // Primed rather than fetched. Rendering here is one synchronous pass, so a query that has to
  // go and ask would still be pending when the HTML is taken — and the page would show a console
  // that had not connected to anything.
  client.setQueryData(queryKeys.connection, {
    state: 'Connected',
    connection: {
      host: 'localhost',
      port: 1883,
      clientId: 'mqttforge',
      tls: false,
      connectedAt: '2026-08-19T04:16:08.000Z',
      subscriptions: 1,
      sessionPresent: false,
    },
  });
  client.setQueryData(queryKeys.colourRules, [
    { filter: 'sensors/+/temp', colour: '#6d28d9' },
    { filter: 'alerts/#', colour: '#b91c1c' },
  ]);

  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  const traffic = [
    ['sensors/livingroom/temp', wobble(60, 21.6, 1.4)],
    ['sensors/garage/temp', wobble(60, 12.6, 0.8)],
    ['sensors/kitchen/humidity', wobble(60, 52, 4)],
    ['sensors/loft/temp', wobble(60, 19.4, 0.6)],
    ['devices/thermostat/battery', wobble(20, 92, 1)],
    ['alerts/door/front', repeat(12, '0', '0', '0', '1', '1')],
    ['alerts/smoke/kitchen', repeat(8, 'clear')],
  ];
  for (const [topic, bodies] of traffic) {
    for (const body of bodies) useLogStore.getState().push({ kind: 'recv', topic, body, qos: 0, stamps: ['qos 0'] });

    // The tree is built from arrivals the same way the live one is, so what it shows is a real
    // topology rather than a hand-written shape.
    useTopicTreeStore.getState().apply(
      bodies.map((payload) => ({
        topic,
        payload,
        mode: 'text',
        size: payload.length,
        qos: 0,
        retain: false,
        receivedAt: '2026-08-19T04:16:08Z',
      })),
    );
  }
  useTopicTreeStore.getState().setAllOpen(true);
  useSelectionStore.getState().select({
    label: 'sensors/livingroom/temp',
    filter: 'sensors/livingroom/temp',
    topic: 'sensors/livingroom/temp',
  });

  const { container } = render(
    <QueryClientProvider client={client}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MQTTForge — the console</title>
${document.head.innerHTML}
</head><body>${container.innerHTML}</body></html>`;
}
