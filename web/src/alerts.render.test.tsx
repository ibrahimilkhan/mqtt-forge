// @ts-nocheck
/**
 * Not a test — a renderer, in the same spirit as gallery.render.test.tsx and for the same reason.
 *
 * The alert rule editor cannot be driven to its interesting states in a browser without a broker
 * behind it: a topic tree to pick out of, a JSON body to pull a path from, ten condition types
 * with their own fields. Here they are built out of store state directly, rendered through the
 * real components, and written out as static pages — the CSS modules are compiled in this
 * environment, so what it writes is what the console draws.
 *
 * It earned its place in the pass that added it: rendering these caught two defects the whole
 * suite passed over. A `<select>` that had never been told to fill its field sat 41px wide in a
 * 96px slot with a hole beside it, and the paragraph behind a help mark was being laid out as a
 * flex item next to the label that opened it — two words wide and thirty lines tall.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react';
import { it } from 'vitest';
import './styles/global.css';
import { queryKeys } from './api/queryKeys';
import { AlertsPanel } from './features/alerts/AlertsPanel';
import { ColoursPanel } from './features/colours/ColoursPanel';
import { RuleEditor } from './features/alerts/RuleEditor';
import { startRuleDraft, forgetDraft } from './features/alerts/ruleDraft';
import { useAlertStore } from './stores/alertStore';
import { useTopicTreeStore } from './stores/topicTreeStore';

const OUT = '/Users/ilkhan/RiderProjects/MqttForge/src/MqttForge.Api/wwwroot';

const STYLE = `<style>
  body { padding: 24px; background: var(--paper); }
  h2 { font-family: var(--mono); font-size: var(--t-small); letter-spacing: .12em;
       text-transform: uppercase; color: var(--muted); margin: 26px 0 10px; }
  .plate { background: var(--surface); border-radius: var(--r-plate); padding: 16px 18px; }
  nav a { font-family: var(--mono); font-size: var(--t-small); margin-right: 14px; }
</style>`;

const NAV = ['alerts-editor', 'alerts-topic', 'alerts-field', 'alerts-help', 'alerts-panel', 'alerts-empty', 'alerts-conditions', 'colours-panel', 'colours-empty', 'colours-pick', 'colours-message', 'colours-narrow']
  .map((name) => `<a href="/${name}.html">${name}</a>`)
  .join('');

/**
 * A select's chosen option, written into the markup.
 *
 * React sets `value` on the element and never touches the option's `selected` ATTRIBUTE, so
 * innerHTML always shows the first option whatever the form is actually set to — which had these
 * pages showing 'Threshold' under every condition in an 'all' of three different ones. Serialising
 * is the one moment the attribute matters.
 */
function pinSelects(root) {
  root.querySelectorAll('select').forEach((select) => {
    [...select.options].forEach((option) => {
      if (option.value === select.value) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    });
  });

  return root.innerHTML;
}

const page = (title, inner) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>MQTTForge — ${title}</title>
${document.head.innerHTML}
${STYLE}
</head><body><nav>${NAV}</nav>${inner}</body></html>`;

function seed() {
  useTopicTreeStore.getState().reset();
  act(() =>
    useTopicTreeStore.getState().apply([
      { topic: 'plant/boiler/temp', payload: '{"temp": 91.2, "pump": {"state": "RUN"}, "radios": [{"crc": 3}]}' },
      { topic: 'plant/boiler/flow', payload: '12.5' },
      { topic: 'plant/boiler/pressure', payload: '{"bar": 4.1}' },
      { topic: 'plant/kiln/temp', payload: '{"temp": 1180}' },
      { topic: 'plant/kiln/door', payload: '{"state": "SHUT"}' },
      { topic: 'site/gateway/status', payload: '{"uptime": 90210, "rssi": -67}' },
    ]),
  );
}

function editor(client, width) {
  forgetDraft('rule:new');
  const draftId = startRuleDraft();
  const view = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width }}>
        <RuleEditor draftId={draftId} onDone={() => {}} onBack={() => {}} />
      </div>
    </QueryClientProvider>,
  );

  return view;
}

it.skipIf(!existsSync(OUT))('writes the alert editor pages', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.alertRules, {
    rules: [],
    topicPrefix: 'mqttforge/alerts/',
    allowWebhooks: true,
  });

  seed();

  // 1 — the form as it opens, at the width the panel gives it.
  let view = editor(client, 1180);
  writeFileSync(`${OUT}/alerts-editor.html`, page('the rule editor', pinSelects(view.container)));
  view.unmount();

  // 2 — the topic tree open under the filter.
  view = editor(client, 1180);
  act(() => {
    fireEvent.click(view.getByRole('button', { name: 'Show topics on the broker' }));
  });
  writeFileSync(`${OUT}/alerts-topic.html`, page('the topic picker', pinSelects(view.container)));
  view.unmount();

  // 3 — a real message open under Field.
  view = editor(client, 1180);
  act(() => {
    fireEvent.change(view.getByLabelText('Topic filter'), {
      target: { value: 'plant/boiler/temp' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Show fields in a message' }));
  });
  writeFileSync(`${OUT}/alerts-field.html`, page('the field picker', pinSelects(view.container)));
  view.unmount();

  // 4 — every mark pressed at once, which is not a state a reader reaches but is the one that
  // shows whether the help fits the columns it lands in.
  view = editor(client, 1180);
  act(() => {
    for (const name of [
      'What What it watches means',
      'What When it fires means',
      'What Everything else means',
      'What Field means',
      'What its own clear rule means',
    ]) {
      fireEvent.click(view.getByRole('button', { name }));
    }
  });
  writeFileSync(`${OUT}/alerts-help.html`, page('the help behind the marks', pinSelects(view.container)));
  view.unmount();

  // 5b — the condition types with the most fields in them, which is where a narrow field's own
  // label is longest and a row is most likely to come out crooked.
  const conditions = ['all', 'outlier', 'pulse', 'band'].map((type) => {
    const one = editor(client, 1180);
    act(() => {
      fireEvent.change(one.getByLabelText('Condition'), { target: { value: type } });
    });

    if (type === 'all') {
      // One act per press. Batched into a single one, the second press runs against the closure
      // the first render made, so three 'add' clicks add the same one child.
      for (let n = 0; n < 3; n++) {
        act(() => {
          fireEvent.click(one.getByRole('button', { name: 'Add a condition' }));
        });
      }
      // Three different kinds, because the point of the page is telling them apart.
      ['pattern', 'silence'].forEach((kind, at) =>
        act(() => {
          fireEvent.change(one.getByLabelText(`Condition ${at + 2}`), { target: { value: kind } });
        }),
      );
    }

    const html = pinSelects(one.container);
    one.unmount();
    return `<h2>${type}</h2>${html}`;
  });
  writeFileSync(`${OUT}/alerts-conditions.html`, page('the condition forms', conditions.join('')));

  // 5 — the list and the standing alarms, which is where the three levels have to be told apart.
  const alarm = (id, severity, ruleName, topic, reason) => ({
    id, ruleId: id, ruleName, topic, severity,
    firedAt: '2026-09-01T09:00:00Z', lastSeenAt: '2026-09-01T09:04:00Z',
    resolvedAt: null, resolvedBy: null, mutedUntil: null,
    count: 12, reason, value: 91.2, sample: '{"temp": 91.2}', actions: ['screen'],
  });
  const rule = (id, name, severity, filter) => ({
    id, name, enabled: true, filter, field: '$.temp',
    condition: { type: 'threshold', op: 'gt', value: 90 },
    clear: null, for: 30, cooldown: 60, severity, actions: [{ type: 'screen' }],
  });

  client.setQueryData(queryKeys.alertRules, {
    rules: [
      rule('boiler', 'Boiler over 90', 'critical', 'plant/+/temp'),
      rule('kiln', 'Kiln door left open', 'warn', 'plant/kiln/door'),
      rule('gw', 'Gateway signal weak', 'info', 'site/gateway/status'),
    ],
    topicPrefix: 'mqttforge/alerts/',
    allowWebhooks: true,
  });

  act(() =>
    useAlertStore.setState({
      active: [
        alarm('boiler', 'critical', 'Boiler over 90', 'plant/boiler/temp', '91.2 is over 90'),
        alarm('kiln', 'warn', 'Kiln door left open', 'plant/kiln/door', 'OPEN is not SHUT'),
        alarm('gw', 'info', 'Gateway signal weak', 'site/gateway/status', '-67 is under -60'),
      ],
      history: [],
      muted: [],
      rules: [],
      warming: [],
      capped: [],
      dropped: 0,
      webhooksDropped: 0,
      suppressed: 0,
      blindSeconds: 0,
    }),
  );

  const panel = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width: 760 }}>
        <AlertsPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  writeFileSync(`${OUT}/alerts-panel.html`, page('the alerts panel', pinSelects(panel.container)));
  panel.unmount();

  // 6 — the panel with nothing in it, at the width the workspace actually gives it. This is the
  // first thing anybody sees, and the one state a running console never shows you again.
  client.setQueryData(queryKeys.alertRules, {
    rules: [],
    topicPrefix: 'mqttforge/alerts/',
    allowWebhooks: true,
  });

  const bare = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width: 1180 }}>
        <AlertsPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  writeFileSync(`${OUT}/alerts-empty.html`, page('no rules yet', pinSelects(bare.container)));
  bare.unmount();

  // 7 — the colours panel, which is the same page as the alerts one and has to look like it.
  client.setQueryData(queryKeys.colourRules, [
    // Two colours: the topic in one, the message under it in another. The rest carry only the
    // first, which is what most rules mean — the payload stays in the console's own ink.
    { filter: 'plant/boiler/#', colour: '#ab3520', bodyColour: '#5c6f84' },
    { filter: 'plant/+/temp', colour: '#0d7a63' },
    { filter: 'site/gateway/status', colour: '#0e4260', bodyColour: '#456eb5' },
    // Shadowed by the two above it: every topic it covers has already been taken.
    { filter: 'plant/#', colour: '#a4681c' },
  ]);

  const colours = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width: 1180 }}>
        <ColoursPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  writeFileSync(`${OUT}/colours-panel.html`, page('the colours panel', pinSelects(colours.container)));
  colours.unmount();

  // The tree, reached from inside the panel that now covers it.
  const picking = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width: 1180 }}>
        <ColoursPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  act(() => {
    fireEvent.click(picking.getByRole('button', { name: 'Show topics on the broker for rule 2' }));
  });
  writeFileSync(`${OUT}/colours-pick.html`, page('picking a topic', pinSelects(picking.container)));
  picking.unmount();

  // The message colour being chosen: the shortlist, and the way back out of it under the rule.
  const message = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width: 1180 }}>
        <ColoursPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  act(() => {
    fireEvent.click(
      message.getByRole('button', { name: 'Choose a message colour for plant/+/temp' }),
    );
  });
  writeFileSync(`${OUT}/colours-message.html`, page('a message colour', pinSelects(message.container)));
  message.unmount();

  // The same list in a phone's width, where the table gives up being a table: the five columns
  // that survive are the number, the two swatches, the filter and the ×, with the count dropped
  // to a line of its own underneath.
  const narrow = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width: 360 }}>
        <ColoursPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  writeFileSync(`${OUT}/colours-narrow.html`, page('a narrow panel', pinSelects(narrow.container)));
  narrow.unmount();

  client.setQueryData(queryKeys.colourRules, []);

  const noColours = render(
    <QueryClientProvider client={client}>
      <div className="plate" style={{ width: 1180 }}>
        <ColoursPanel onClose={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  writeFileSync(`${OUT}/colours-empty.html`, page('no colours yet', pinSelects(noColours.container)));
  noColours.unmount();

  useTopicTreeStore.getState().reset();
});
