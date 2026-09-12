// @ts-nocheck
/**
 * Not a test — a renderer, in the same spirit as reconnect.render.test.tsx.
 *
 * The rail's alert badge, at each of the three levels and at both rail widths. It cannot be
 * driven to any of them in a browser without a rule, a broker and a reading that breaks it, and
 * the thing being looked at is a number in the corner of a button — which is exactly the sort of
 * thing that renders wrong for months without anybody opening the panel that would show it.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react';
import { it } from 'vitest';
import './styles/global.css';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';
import { useAlertStore } from './stores/alertStore';

const OUT = '/Users/ilkhan/RiderProjects/MqttForge/src/MqttForge.Api/wwwroot';

const STYLE = `<style>
  body { padding: 20px; background: var(--paper); display: flex; flex-wrap: wrap; gap: 28px; }
  figure { margin: 0; }
  figcaption { font-family: var(--mono); font-size: var(--t-nano); letter-spacing: .1em;
               text-transform: uppercase; color: var(--muted); margin: 0 0 6px 2px; }
  .cut { overflow: hidden; border-radius: var(--r-plate); box-shadow: 0 0 0 1px var(--rule); }
</style>`;

const alert = (id, severity) => ({
  id,
  ruleId: 'r1',
  ruleName: 'Kiln too hot',
  topic: 'sensors/kiln/temp',
  severity,
  firedAt: '2026-09-12T09:00:00.000Z',
  lastSeenAt: '2026-09-12T09:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  mutedUntil: null,
  count: 1,
  reason: 'value 918.4 over 900',
  value: 918.4,
  sample: null,
  actions: ['screen'],
});

/** The rail on its own, with the alerts store standing where the hub's snapshot would. */
function rail({ count, severity, shut }) {
  useAlertStore.setState({
    active: Array.from({ length: count }, (_, i) => alert(`a${i}`, i === 0 ? severity : 'info')),
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );

  if (shut) {
    act(() =>
      fireEvent.click(
        [...container.querySelectorAll('button')].find((button) =>
          /the rail$/.test(button.getAttribute('aria-label') ?? ''),
        ),
      ),
    );
  }

  const nav = container.querySelector('nav[aria-label="Panels"]').parentElement;
  const width = shut ? 52 : 210;

  return `<figure><figcaption>${severity} · ${count} · ${shut ? 'shut' : 'open'}</figcaption>
    <div class="cut" style="width:${width}px">${nav.outerHTML}</div></figure>`;
}

const PATIENCE = 60_000;

it.skipIf(!existsSync(OUT))('writes the rail badge at each level', () => {
  const parts = [];

  for (const shut of [false, true]) {
    for (const [severity, count] of [
      ['critical', 3],
      ['warn', 1],
      ['info', 12],
    ]) {
      parts.push(rail({ count, severity, shut }));
    }
  }

  useAlertStore.setState({ active: [] });
  writeFileSync(
    `${OUT}/rail-badge.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>MQTTForge — the rail's badge</title>
${document.head.innerHTML}
${STYLE}
</head><body>${parts.join('\n')}</body></html>`,
  );
}, PATIENCE);
