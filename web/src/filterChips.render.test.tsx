// @ts-nocheck
/**
 * Not a test — a renderer, in the same spirit as reconnect.render.test.tsx.
 *
 * The row of subscription chips, in the four states a reader meets: one picked, the rest not, one
 * a rule holds and one mid-unsubscribe. None of them is reachable on the static console pages —
 * those render a console with nothing subscribed — and the differences between them are a border
 * colour and a hover, which is exactly the kind of thing that stops working without anybody
 * noticing.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { it } from 'vitest';
import './styles/global.css';
import { FilterChips } from './features/subscribe/FilterChips';
import { useSelectionStore } from './stores/selectionStore';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../src/MqttForge.Api/wwwroot');

const STYLE = `<style>
  body { padding: 24px; background: var(--paper); }
  h2 { font-family: var(--mono); font-size: var(--t-nano); letter-spacing: .1em;
       text-transform: uppercase; color: var(--muted); margin: 22px 0 8px; }
  .plate { background: var(--paper); max-width: 620px; }
</style>`;

const FILTERS = [
  { topicFilter: 'sensors/#', console: true, rules: false },
  { topicFilter: 'plant/+/temp', console: true, rules: false },
  { topicFilter: 'alerts/#', console: false, rules: true },
  { topicFilter: 'devices/gateway/+', console: true, rules: false },
];

const PATIENCE = 60_000;

it.skipIf(!existsSync(OUT))('writes the subscription chips', () => {
  const parts = [];

  const draw = (label, picked, pending) => {
    useSelectionStore.setState({
      selected: picked ? { label: picked, filter: picked, topic: picked } : null,
    });

    const view = render(
      <div className="plate">
        <FilterChips filters={FILTERS} onRemove={() => {}} pendingFilter={pending} />
      </div>,
    );
    parts.push(`<h2>${label}</h2>${view.container.innerHTML}`);
    view.unmount();
  };

  draw('nothing picked', null);
  draw('plant/+/temp picked', 'plant/+/temp');
  draw('devices/gateway/+ on its way out', null, 'devices/gateway/+');

  useSelectionStore.setState({ selected: null });
  writeFileSync(
    `${OUT}/filter-chips.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>MQTTForge — the subscription chips</title>
${document.head.innerHTML}
${STYLE}
</head><body>${parts.join('\n')}</body></html>`,
  );
}, PATIENCE);
