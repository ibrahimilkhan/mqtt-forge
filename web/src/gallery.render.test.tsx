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
import { act, fireEvent, render } from '@testing-library/react';
import { it } from 'vitest';
import './styles/global.css';
import chartStyles from './features/monitor/TrafficChart.module.css';
import { App } from './App';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { ChartPanel } from './features/chart/ChartPanel';
import { WireLog } from './features/monitor/WireLog';
import { ReadingDetail } from './features/monitor/ReadingDetail';
import { domainFor } from './lib/scale';
import { numericSeries } from './lib/series';
import { shapeOf } from './lib/shape';
import { summarise } from './lib/stats';
import { Mark, MarkSolid } from './features/brand/marks';
import { TrafficChart } from './features/monitor/TrafficChart';
import { TrafficLine } from './features/monitor/TrafficLine';
import { queryKeys } from './api/queryKeys';
import { createFakeHub } from './realtime/fakeHub';
import { useAppearanceStore } from './stores/appearanceStore';
import { runFor, runsOf, useLogStore } from './stores/logStore';
import { useSelectionStore } from './stores/selectionStore';
import { useHoldStore } from './features/monitor/useTraffic';
import { useTopicTreeStore } from './stores/topicTreeStore';
import { useZoomStore } from './features/monitor/useZoom';
import { useWindows } from './features/monitor/useWindows';

const OUT = '/Users/ilkhan/RiderProjects/MqttForge/src/MqttForge.Api/wwwroot';

/**
 * The width the plot would have in the box these pages draw it in.
 *
 * jsdom lays nothing out, so a component that asks how wide it is gets nothing — and the chart
 * asks, because whether a dot per reading is a row of dots or a smear is a question only the real
 * width can answer. Told the width it will actually have, the page shows what the app shows.
 */
const PLOT_ACROSS = 380;

/** Reset per render, so a page can show the same run drawn at several plot heights. */
let plotDown = 150;

class MeasuredTo {
  ran: ResizeObserverCallback;

  constructor(ran: ResizeObserverCallback) {
    this.ran = ran;
  }

  observe() {
    this.ran(
      [{ contentRect: { width: PLOT_ACROSS, height: plotDown } } as ResizeObserverEntry],
      this as never,
    );
  }

  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = MeasuredTo as unknown as typeof ResizeObserver;

/** Three runs a page: one screenshot's worth, and no page that has to be scrolled to be read. */
const PER_PAGE = 3;

let id = 0;

/**
 * A run ending about now.
 *
 * Anchored to the clock rather than to a fixed date, because the note reads the newest arrival
 * against the present: a run stamped last Tuesday is a topic that stopped publishing days ago,
 * and every chart on the page would carry a silence alarm that is about the fixture rather than
 * about anything the chart does.
 */
const entries = (topic: string, bodies: string[], everyMs = 1000, stoppedMs = 0) => {
  const ends = Date.now() - everyMs - stoppedMs;

  return bodies
    .map((body, index) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(ends - (bodies.length - 1 - index) * everyMs),
      topic,
      body,
      mode: 'text' as const,
    }))
    .reverse();
};

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
    name: 'The same run, with the quarters marked',
    note: 'Settings → Chart → Grid. The plot always carries its own edge unless that is turned off too — without one, a line lying along the top of the plot cannot be told from a line near the top.',
    grid: 'lines',
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
    name: 'A topic that has stopped',
    note: "The one reading here about whether the run is still happening rather than about the readings in it, and it keeps the bottom-right corner of the note whether it has fired or not. It used to jump to the front when it fired, which dragged every other reading along with it — and it fires and clears on its own, so holding the pane and letting it go again shuffled the note twice.",
    log: entries('sensors/kiln/temp', wobble(60, 1180, 12), 1000, 40_000),
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

/**
 * What React set as a property, written down as an attribute.
 *
 * A `<select value=…>` is a DOM property, not an attribute, so serialising the tree loses which
 * option was chosen and the page opens showing the first one. Nothing is wrong with the console;
 * it is the snapshot that lies — which is worse than an honest bug, since it looks like a
 * setting that does not stick.
 */
function stamp(root: HTMLElement): HTMLElement {
  for (const select of root.querySelectorAll('select')) {
    for (const option of select.options) {
      if (option.value === select.value) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    }
  }

  return root;
}

// Written into the API's static root, which is where a browser can reach it. Absent before the
// web app has been built at least once, and there is nothing to serve it from then either.
it.skipIf(!existsSync(OUT))('writes the gallery', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // One mark, at the three sizes it has to survive: the panel, the open rail, and the strip the
  // rail shuts to — and beside it the solid cut, which is what a favicon and a window list get.
  const marks = (
    <div className="gMarks">
      <figure className="gMark">
        <div className="gMarkRow">
          <span style={{ fontSize: 44, lineHeight: 0 }}>
            <Mark />
          </span>
          <span style={{ fontSize: 26, lineHeight: 0 }}>
            <Mark />
          </span>
          <span style={{ fontSize: 16, lineHeight: 0 }}>
            <Mark />
          </span>
        </div>
        <div className="gRail">
          <span style={{ fontSize: 22, lineHeight: 0 }}>
            <Mark />
          </span>
          <b className="gWord">
            MQTT<span>Forge</span>
          </b>
        </div>
        <figcaption>
          <b>Diyez</b>
          <span>
            the wildcard a fresh connection subscribes to, slanted so it is the character MQTT
            uses rather than a hashtag or a grid
          </span>
        </figcaption>
      </figure>
      <figure className="gMark">
        <div className="gMarkRow">
          <span style={{ fontSize: 44, lineHeight: 0 }}>
            <MarkSolid />
          </span>
          <span style={{ fontSize: 26, lineHeight: 0 }}>
            <MarkSolid />
          </span>
          <span style={{ fontSize: 16, lineHeight: 0 }}>
            <MarkSolid />
          </span>
          <span style={{ fontSize: 12, lineHeight: 0 }}>
            <MarkSolid />
          </span>
        </div>
        <figcaption>
          <b>Diyez, solid</b>
          <span>
            the same drawing cut out of a block, for the sizes and grounds an outline cannot
            hold: the favicon, a tab, a window list, the icon the app wears
          </span>
        </figcaption>
      </figure>
    </div>
  );

  const pages = [];
  for (let at = 0; at < RUNS.length; at += PER_PAGE) pages.push(RUNS.slice(at, at + PER_PAGE));

  const drawn = pages.map((page) =>
    page
      .map((run) => {
        useLogStore.getState().clear();

        const draw = (scale) => {
          useAppearanceStore.setState({ scale, grid: run.grid ?? 'frame' });
          const { container, unmount } = render(
            <QueryClientProvider client={client}>
              <Framed>
                <TrafficChart runs={runsOf(run.log)} />
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

  const nav = [
    'gallery.html',
    ...pages.map((_, i) => `gallery-${i + 1}.html`),
    'gallery-panel.html',
    'gallery-broker.html',
    'gallery-detail.html',
    'gallery-dots.html',
    'gallery-log.html',
    'console.html',
    'console-broker.html',
    'console-colours.html',
    'console-zoomed.html',
    'console-pinned.html',
    'console-shut.html',
    'console-message.html',
  ]
    .map((href, i) => {
      const name =
        href === 'gallery.html'
          ? 'Marks'
          : href === 'gallery-panel.html'
            ? 'Chart panel'
          : href === 'gallery-broker.html'
            ? 'Broker, side by side'
            : href === 'gallery-detail.html'
              ? 'A reading'
              : href === 'gallery-dots.html'
                ? 'The dots'
              : href === 'gallery-log.html'
                ? 'The log'
              : href === 'console.html'
                ? 'The console'
              : href === 'console-broker.html'
                ? 'Broker panel'
              : href === 'console-colours.html'
                ? 'Colour rules'
                : href === 'console-zoomed.html'
                  ? 'Chart opened'
                  : href === 'console-pinned.html'
                    ? 'Charts pinned'
                    : href === 'console-shut.html'
                      ? 'Rail shut'
                    : href === 'console-message.html'
                      ? 'A message opened'
                      : `Charts ${i}`;

      return `<a href="${href}">${name}</a>`;
    })
    .join('');

  const page = (title, inner) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MQTTForge — ${title}</title>
${document.head.innerHTML}
${STYLE}
</head><body>
<h1>MQTT<span style="color:var(--signal)">Forge</span></h1>
<p class="gLede">The mark the tool wears, the rail it stands in, and the chart in every state the
brief asked about. Rendered through the console's own components, so what is below is what the
tool draws.</p>
<nav class="gNav">${nav}</nav>
${inner}
</body></html>`;

  writeFileSync(
    `${OUT}/gallery.html`,
    page('marks', `<h2>The mark</h2>${markBox.innerHTML}`),
  );

  drawn.forEach((inner, i) =>
    writeFileSync(`${OUT}/gallery-${i + 1}.html`, page(`charts ${i + 1}`, `<h2>The chart</h2>${inner}`)),
  );

  writeFileSync(`${OUT}/console.html`, console_(client, { panel: null }));
  writeFileSync(`${OUT}/console-colours.html`, console_(client, { panel: 'colours' }));
  // The panel the console opens on, which is the one page that shows the broker form whole.
  writeFileSync(`${OUT}/console-broker.html`, console_(client, { panel: 'broker' }));
  // The same console with the chart thrown open, which is the state a static page can show and
  // a click cannot be recorded in.
  writeFileSync(`${OUT}/console-zoomed.html`, console_(client, { zoomed: true, panel: null }));
  // And the same console with two charts pinned off it, standing over a console still in use.
  writeFileSync(`${OUT}/console-pinned.html`, console_(client, { pinned: true, panel: null }));
  // The rail narrowed to its strip, which is the other half of the rail's design and a click
  // away rather than a state the app can be started in.
  writeFileSync(`${OUT}/console-shut.html`, console_(client, { panel: null, rail: 'shut' }));
  // One message taken out of the run and opened, which is the one state of the log a click makes
  // and a static page cannot.
  writeFileSync(`${OUT}/console-message.html`, console_(client, { opened: true, panel: null }));
  useWindows.setState({ windows: [] });

  // Back to the defaults: the runs above set the range on the store to draw themselves both
  // ways, and a panel showing the last of those would be showing the renderer's state rather
  // than the console's.
  useAppearanceStore.getState().reset();

  // The panel is a column in the console, so it is shown at a column's width rather than at the
  // page's — a list of switches read across seven hundred pixels is not the thing being checked.
  const { container: chartPanel } = render(
    <QueryClientProvider client={client}>
      <div style={{ width: 320, border: '1px solid var(--rule)', borderRadius: 3 }}>
        <ChartPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  writeFileSync(
    `${OUT}/gallery-panel.html`,
    page('the chart panel', `<h2>The chart panel</h2>${stamp(chartPanel).innerHTML}`),
  );

  writeFileSync(`${OUT}/gallery-broker.html`, page('the broker panel', brokerStates()));

  writeFileSync(
    `${OUT}/gallery-detail.html`,
    page('one reading, opened', `<h2>One reading, opened</h2>${detail()}`),
  );

  writeFileSync(`${OUT}/gallery-log.html`, page('the log', `<h2>The log</h2>${logStates(client)}`));

  writeFileSync(
    `${OUT}/gallery-dots.html`,
    page('a dot per reading', `<h2>A dot per reading</h2>${dotSizes(client)}`),
  );
});

/**
 * The same run at three plot heights.
 *
 * A mark that is right in a region forty pixels tall is a speck in a chart thrown open over the
 * window, and a mark that is right there is a blot in the region — so the dot is a fraction of the
 * plot's own height. That only shows side by side, and the page is static, so each is rendered
 * against the height it will really have.
 */
function dotSizes(client) {
  const series = numericSeries(entries('sensors/room/temp', wobble(34, 21.5, 2.2)))!;
  const values = series.readings.map((reading) => reading.value);
  const summary = summarise(values)!;
  const shape = shapeOf(series.readings, summary);
  const domain = domainFor(values, summary, 'typical');
  const was = plotDown;

  const drawn = [
    { down: 90, about: 'a folded-down region — the dot at its floor' },
    { down: 220, about: 'an ordinary chart region' },
    { down: 460, about: 'the chart thrown open over the console — the dot at its ceiling' },
  ]
    .map(({ down, about }) => {
      plotDown = down;
      const { container, unmount } = render(
        <QueryClientProvider client={client}>
          <div
            style={{
              width: 440,
              height: down,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 8,
              background: 'var(--surface)',
              border: '1px solid var(--rule)',
              borderRadius: 3,
              padding: 10,
            }}
          >
            <TrafficLine series={series} summary={summary} domain={domain} shape={shape} />
          </div>
        </QueryClientProvider>,
      );
      const html = container.innerHTML;
      unmount();

      return `<div class="gCell"><span class="gTag">${down}px — ${about}</span>${html}</div>`;
    })
    .join('');

  plotDown = was;

  return `<div class="gRow" style="align-items:flex-start">${drawn}</div>`;
}

/**
 * The log in the states it actually reaches.
 *
 * The pane shows one entry until asked, so the interesting states — a run of history, a wildcard
 * mixing topics, a command that failed, a payload too big for the region — are all behind a click
 * or behind traffic that has not happened yet.
 */
function logStates(client) {
  const shown = [
    {
      name: 'One topic, as it arrives',
      note: 'The default: the newest arrival, and a count of what is behind it.',
      seed: () => {
        wobble(60, 21.5, 1.4).forEach((body) =>
          useLogStore.getState().push({ kind: 'recv', topic: 'sensors/livingroom/temp', body, qos: 0, stamps: ['qos 0', '4 b'] }),
        );
      },
      pick: { label: 'sensors/livingroom/temp', filter: 'sensors/livingroom/temp' },
      open: true,
    },
    {
      name: 'A branch, mixing topics',
      note: 'Every row names its own topic, which is what tells them apart — and what is repeated when they do not need telling apart.',
      seed: () => {
        for (let i = 0; i < 8; i++) {
          useLogStore.getState().push({ kind: 'recv', topic: 'sensors/livingroom/temp', body: (21 + i * 0.3).toFixed(2), qos: 0, stamps: ['qos 0', '5 b'] });
          useLogStore.getState().push({ kind: 'recv', topic: 'sensors/livingroom/humidity', body: `${52 + i}`, qos: 1, stamps: ['qos 1', 'retained', '2 b'] });
        }
      },
      pick: { label: 'sensors/livingroom/#', filter: 'sensors/livingroom/#' },
      open: true,
    },
    {
      name: 'A silence the console can explain',
      note: 'Every fault the console recorded used to be written to a log nothing drew, so a refused subscription and a quiet sensor gave the reader the same sentence. A failure that has not since been answered is now the answer.',
      seed: () => {
        useLogStore.getState().push({ kind: 'fault', verb: 'Subscribe failed', topic: 'sensors/kiln/#', body: 'Not authorised (135)' });
      },
      pick: { label: 'sensors/kiln/#', filter: 'sensors/kiln/#' },
      open: false,
    },
    {
      name: 'A silence the console cannot explain',
      note: 'Nothing has failed, so the topic really is quiet, and the pane says so.',
      seed: () => {
        useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/attic/#' });
      },
      pick: { label: 'sensors/attic/#', filter: 'sensors/attic/#' },
      open: false,
    },
    {
      name: 'A payload bigger than the pane',
      note: 'Cut at about five hundred characters, with the rest a click away.',
      seed: () => {
        useLogStore.getState().push({
          kind: 'recv',
          topic: 'devices/gateway/config',
          body: JSON.stringify({ firmware: '4.2.1-rc3', uptime: 918273, radios: Array.from({ length: 12 }, (_, i) => ({ id: `radio-${i}`, channel: 11 + i, dbm: -42 - i, peers: 3 + (i % 5) })) }),
          qos: 1,
          stamps: ['qos 1', 'retained', '892 b'],
        });
      },
      pick: { label: 'devices/gateway/config', filter: 'devices/gateway/config' },
      open: false,
    },
    {
      name: 'More of the run than the region can show',
      note: 'Opened, the run is nearly always taller than the region the workspace gave it — and on this platform the scrollbar that would say so is not drawn until the pointer is already moving. So the pane says it, pinned to the fold, pointing at what is under it.',
      seed: () => {
        wobble(60, 21.5, 1.4).forEach((body) =>
          useLogStore.getState().push({ kind: 'recv', topic: 'sensors/livingroom/temp', body, qos: 0, stamps: ['qos 0', '4 b'] }),
        );
      },
      pick: { label: 'sensors/livingroom/temp', filter: 'sensors/livingroom/temp' },
      open: true,
      // The height the workspace would give the region, and what a row costs in it. jsdom lays
      // nothing out, so the pane is told both — otherwise every row measures zero and the pane
      // reads a run of twenty-five as entirely on screen.
      region: 260,
      row: 90,
    },
    {
      name: 'Nothing picked yet',
      note: 'The pane before a reader has told it what to show.',
      seed: () => {},
      pick: null,
      open: false,
    },
  ];

  return shown
    .map((state) => {
      useLogStore.getState().clear();
      useHoldStore.getState().release();
      state.seed();
      if (state.pick) useSelectionStore.getState().select(state.pick);
      else useSelectionStore.getState().clear();

      const measured = state.region ? laidOut(state.region, state.row) : null;
      const { container, unmount } = render(
        <QueryClientProvider client={client}>
          <div
            data-region={state.region ? '' : undefined}
            style={{
              width: 360,
              background: 'var(--surface)',
              border: '1px solid var(--rule)',
              borderRadius: 3,
              padding: '11px 20px 16px',
              // A region that scrolls, which is what the workspace gives this pane.
              ...(state.region ? { height: state.region, overflowY: 'auto' } : {}),
            }}
          >
            <WireLog />
          </div>
        </QueryClientProvider>,
      );

      // The history is behind a click, and a static page cannot carry one — so the click is made
      // here and the markup taken afterwards.
      if (state.open) {
        const opener = container.querySelector('[aria-expanded="false"]');
        if (opener) act(() => fireEvent.click(opener));
      }

      const html = container.innerHTML;
      measured?.();
      unmount();

      return `<section class="gRun"><h3>${state.name}</h3><p>${state.note}</p>
        <div class="gRow"><div class="gCell">${html}</div></div></section>`;
    })
    .join('');
}

/**
 * Lends jsdom a layout for the run of one region: a fold `deep` pixels down, and rows of `row`
 * each from the top of the list. Returns the way to take it back.
 */
function laidOut(deep, row) {
  const own = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute?.('data-region')) return { top: 0, bottom: deep };
    if (this.getAttribute?.('data-testid') !== 'entry') return own.call(this);
    const index = [...(this.parentElement?.children ?? [])].indexOf(this);

    return { top: index * row, bottom: index * row + row };
  };

  return () => {
    Element.prototype.getBoundingClientRect = own;
  };
}

/**
 * The card that opens on a reading, in each of the four corners it can take.
 *
 * It is placed away from the reading it describes — furthest corner from the point — so it never
 * covers what was clicked. Which corner that is comes off two data attributes, so the four cases
 * can be drawn side by side without a pointer.
 */
function detail() {
  const run = entries('sensors/room/temp', wobble(60, 21.5, 2.4));
  const series = numericSeries(run)!;
  const values = series.readings.map((reading) => reading.value);
  const summary = summarise(values)!;
  const shape = shapeOf(series.readings, summary);
  const domain = domainFor(values, summary, 'typical');

  const corners = [
    { side: 'right', half: 'high', about: 'reading in the left half, high on the plot' },
    { side: 'left', half: 'high', about: 'reading in the right half, high on the plot' },
    { side: 'right', half: 'low', about: 'reading in the left half, low on the plot' },
    { side: 'left', half: 'low', about: 'reading in the right half, low on the plot' },
  ];

  // A reading wearing both marks the plot can put on one: past the fences, and past the range
  // the plot was drawn in. The card is where those marks are put into words.
  const spiked = numericSeries(entries('sensors/room/temp', [...repeat(20, '1', '2', '3'), '4000']))!;
  const spikedValues = spiked.readings.map((reading) => reading.value);
  const spikedSummary = summarise(spikedValues)!;
  corners.push({ side: 'left', half: 'low', about: 'a reading wearing both marks' });

  return `<div class="gRow">${corners
    .map(({ side, half, about }, index) => {
      const marked = index === corners.length - 1;
      const { container } = render(
        <div
          style={{
            position: 'relative',
            width: 460,
            height: 250,
            background: 'var(--surface)',
            border: '1px solid var(--rule)',
            borderRadius: 3,
          }}
        >
          <div className={chartStyles.detailSlot} data-side={side} data-half={half}>
            <ReadingDetail
              series={marked ? spiked : series}
              summary={marked ? spikedSummary : summary}
              shape={marked ? shapeOf(spiked.readings, spikedSummary) : shape}
              domain={
                marked ? domainFor(spikedValues, spikedSummary, 'typical') : domain
              }
              at={marked ? spiked.readings.length - 1 : index === 3 ? 0 : 20 + index * 7}
              onClose={() => {}}
            />
          </div>
        </div>,
      );

      return `<div class="gCell"><span class="gTag">${about}</span>${container.innerHTML}</div>`;
    })
    .join('')}</div>`;
}

/**
 * The whole console with traffic in it, as one static page.
 *
 * The screenshots in the README were taken against a live broker, and there is not one here. The
 * console does not need one to be looked at: the log, the tree and the selection are stores, and
 * a fake hub satisfies the bridge. What this writes is the real layout with real components in
 * it, at whatever size the window opens — which is what a screenshot of the console is.
 */
function console_(client, { zoomed = false, pinned = false, opened = false, panel = 'broker', rail = 'open' } = {}) {
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
    { filter: 'sensors/+/temp', colour: '#8161b3' },
    { filter: 'alerts/#', colour: '#b7514e' },
  ]);

  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useZoomStore.setState({ zoomed, box: null });
  // Two runs on screen at once, which is the thing one chart in one column cannot do. Placed by
  // hand here; in the console they are placed by whoever dragged them there.
  useWindows.setState({
    windows: pinned
      ? [
          {
            id: 'chart-1',
            pane: { kind: 'chart', filter: 'sensors/garage/temp' },
            label: 'sensors/garage/temp',
            box: { x: 300, y: 96, w: 470, h: 300 },
            fixed: true,
          },
          {
            id: 'chart-2',
            pane: { kind: 'chart', filter: 'sensors/kitchen/humidity' },
            label: 'sensors/kitchen/humidity',
            box: { x: 420, y: 330, w: 470, h: 300 },
            // One pinned and one loose, so the page shows both states of the bar at once.
            fixed: false,
          },
        ]
      : [],
  });
  // A broker with enough on it to look like one: three branches, a few kinds of reading, and the
  // colour rules above landing on more than one row.
  const traffic = [
    ['sensors/livingroom/temp', wobble(60, 21.6, 1.4)],
    ['sensors/livingroom/humidity', wobble(60, 48, 3)],
    ['sensors/garage/temp', wobble(60, 12.6, 0.8)],
    ['sensors/garage/humidity', wobble(40, 63, 5)],
    ['sensors/kitchen/temp', wobble(60, 23.1, 0.9)],
    ['sensors/kitchen/humidity', wobble(60, 52, 4)],
    ['sensors/loft/temp', wobble(60, 19.4, 0.6)],
    ['devices/thermostat/battery', wobble(20, 92, 1)],
    ['devices/thermostat/state', repeat(4, '{"mode":"heat","target":21}')],
    ['devices/lamp/hall/state', repeat(6, 'on', 'on', 'off')],
    ['devices/lamp/porch/state', repeat(6, 'off', 'on')],
    ['home/energy/meter', wobble(30, 4213, 6)],
    ['home/energy/tariff', repeat(4, 'night')],
    ['alerts/door/front', repeat(12, '0', '0', '0', '1', '1')],
    ['alerts/door/back', repeat(10, '0')],
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
  // The filter the tree itself would set — '/#' on the end, which matches the topic and
  // everything under it. Written the short way, no row read as selected on these pages and the
  // controls that ride on the selected row were never drawn.
  useSelectionStore.getState().select({
    label: 'sensors/livingroom/temp',
    filter: 'sensors/livingroom/temp/#',
    topic: 'sensors/livingroom/temp',
  });

  // One message taken out of the run and opened. Seeded here rather than clicked, for the same
  // reason the panel above is: a static page cannot carry a click, and this is the only state of
  // the log that one makes.
  if (opened) {
    const configured = {
      topic: 'devices/gateway/config',
      payload: JSON.stringify({
        firmware: '4.2.1-rc3',
        uptime: 918273,
        radios: [
          { id: 'radio-0', channel: 11, dbm: -42, peers: 3 },
          { id: 'radio-1', channel: 12, dbm: -43, peers: 4 },
        ],
      }),
      mode: 'text',
      size: 214,
      qos: 1,
      retain: true,
      receivedAt: '2026-08-19T04:16:08.250Z',
    };
    useLogStore.getState().appendReceived([configured]);
    const entry = runFor(useLogStore.getState().byTopic, 'devices/gateway/config')[0];
    useWindows.setState({
      windows: [
        {
          id: 'window-1',
          pane: { kind: 'message', entry },
          label: '04:16:08 devices/gateway/config',
          box: { x: 250, y: 150, w: 470, h: 340 },
          fixed: true,
        },
      ],
    });
  }

  const { container } = render(
    <QueryClientProvider client={client}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );

  // The console opens with the Broker panel over the first column, which is right for a reader
  // who has just started it and wrong for a picture of the tool working. The panel is a click,
  // and a static page cannot carry one — so the click is made here.
  const menu = (name) =>
    [...container.querySelectorAll('nav[aria-label="Panels"] button')].find(
      (button) => button.textContent === name,
    );
  if (panel !== 'broker') {
    act(() => fireEvent.click(menu('Broker')));
    if (panel) act(() => fireEvent.click(menu(panel[0].toUpperCase() + panel.slice(1))));
  }

  // Same click, for the same reason: the strip is a state the reader puts the rail in.
  if (rail === 'shut') {
    act(() =>
      fireEvent.click(
        [...container.querySelectorAll('button')].find(
          (button) => button.getAttribute('aria-label') === 'Panel menu',
        ),
      ),
    );
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MQTTForge — the console</title>
${document.head.innerHTML}
</head><body>${stamp(container).innerHTML}</body></html>`;
}

/**
 * The broker panel in the six states it is read in, at the width of the column it lives in.
 *
 * Side by side, because the point of the layout is what each state puts first: nothing connected
 * and it is the address; connected and it is the link, with the form folded behind one line; a
 * failure and it is the sentence saying so, with the way out under it; a certificate and it is
 * the encryption box, held on by something folded away below; and everything unfolded, which is
 * the whole of what the panel can ask for and is what it used to show on every visit.
 */
function brokerStates() {
  const one = (label, prime, unfold = false, fill) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    prime(client);

    const { container } = render(
      <QueryClientProvider client={client}>
        <div style={{ width: 900, border: '1px solid var(--rule)', borderRadius: 3 }}>
          <BrokerPanel onClose={() => {}} open={() => {}} />
        </div>
      </QueryClientProvider>,
    );

    // What the reader would have typed before pressing Connect. Only the failure state needs it,
    // and it needs it badly: the failure names the broker it was about, and a panel whose address
    // box disagreed with its own error message would look like the bug rather than the fix.
    // Found by property rather than by `#id`: React sets `id` on the element without setting the
    // attribute, so a CSS selector matches nothing here. It is the same gap `stamp` exists to
    // close, met a step earlier.
    if (fill) {
      fill((id) => [...container.querySelectorAll('input')].find((input) => input.id === id));
    }

    // A property React set, written down as an attribute — the same reason `stamp` exists.
    if (unfold) {
      for (const details of container.querySelectorAll('details')) details.setAttribute('open', '');
    }

    return `<div class="gCell"><span class="gTag">${label}</span>${stamp(container).innerHTML}</div>`;
  };

  const link = (client) =>
    client.setQueryData(queryKeys.connection, {
      state: 'Connected',
      connection: {
        host: 'mqtt.hsl.fi',
        port: 8883,
        clientId: 'mqttforge-console',
        useTls: true,
        transport: 'tcp',
        protocolVersion: 'v500',
        connectedAt: new Date(Date.now() - 184_000).toISOString(),
        sessionPresent: false,
        assignedClientId: null,
        serverKeepAlive: 60,
      },
    });

  const nothing = (client) => client.setQueryData(queryKeys.connection, { state: 'Disconnected' });

  // A host that owns a window owns a file dialog, so the three certificate boxes each get a
  // button beside them. False is what a browser is told, and what every other state here shows.
  const withDialog = (client) => {
    nothing(client);
    client.setQueryData(queryKeys.certificateDialog, { canChoose: true });
  };

  // Brokers the reader kept. The section is absent until there is one, so this is the only place
  // the chips and the rule above them can be looked at.
  const kept = (client) => {
    nothing(client);
    client.setQueryData(queryKeys.savedProfiles, [
      { name: 'Lab mosquitto', connection: { host: 'localhost', port: 1883, clientId: 'mqttforge-console', username: null, hasPassword: false, useTls: false, transport: 'tcp', protocolVersion: 'auto', webSocketPath: null, cleanSession: true, sessionExpiryInterval: null, tls: null } },
      { name: 'Staging over TLS', connection: { host: 'mqtt.staging.example', port: 8883, clientId: 'mqttforge-console', username: 'alice', hasPassword: true, useTls: true, transport: 'tcp', protocolVersion: 'auto', webSocketPath: null, cleanSession: true, sessionExpiryInterval: null, tls: null } },
      { name: 'Gateway over wss', connection: { host: 'gw.example', port: 8084, clientId: 'mqttforge-console', username: null, hasPassword: false, useTls: true, transport: 'webSocket', protocolVersion: 'auto', webSocketPath: '/mqtt', cleanSession: true, sessionExpiryInterval: null, tls: null } },
    ]);
  };

  // A failure the panel can offer a way out of: plain MQTT aimed at the encrypted port. The
  // suggestion button exists in no other state, and a shut fold hides nothing from the DOM, so
  // this is the only place it can be looked at rather than reasoned about.
  const faulted = (client) =>
    client.setQueryData(queryKeys.connection, {
      state: 'Faulted',
      failure: {
        reason: 'timeout',
        host: 'broker.example',
        port: 8883,
        clientId: 'mqttforge-console',
        useTls: false,
        transport: 'tcp',
        protocolVersion: 'auto',
      },
    });

  return `<h2>The broker panel</h2><div style="display:grid;gap:18px">
${one('nothing connected', nothing)}
${one('a link up', link)}
${one('a failure with a way out', faulted, false, (box) => {
  fireEvent.change(box('address'), { target: { value: 'broker.example' } });
  fireEvent.change(box('port'), { target: { value: '8883' } });
})}
${one('a certificate, settling it', nothing, false, (box) => {
  fireEvent.change(box('clientCertPath'), { target: { value: '/etc/mqtt/client.pem' } });
})}
${one('brokers you kept', kept)}
${one('every fold opened', withDialog, true)}
</div>`;
}
