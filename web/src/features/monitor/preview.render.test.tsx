// @ts-nocheck — throwaway: node's types are not in the app's project, and this file is deleted
// as soon as the page it writes has been looked at.
// Renders the pane over many shapes of traffic and writes what it produced to a static page.
import { readFileSync, writeFileSync } from 'node:fs';
import { fireEvent, screen } from '@testing-library/react';
import { describe, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { WireLog } from './WireLog';

const root = '/Users/ilkhan/RiderProjects/MqttForge';

describe('preview', () => {
  it('writes the pane to a page', () => {
    const shot = (topic: string, bodies: string[], options: { view?: 'dist'; field?: string } = {}) => {
      useLogStore.getState().clear();
      bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));
      useSelectionStore.getState().select({ label: topic, filter: topic });

      const view = render(<WireLog />);
      if (options.view === 'dist') fireEvent.click(screen.getByRole('button', { name: 'Distribution' }));
      if (options.field) fireEvent.click(screen.getByRole('button', { name: `Chart ${options.field}` }));

      const html = document.body.innerHTML;
      view.unmount();
      return html;
    };

    const numbers = (...values: number[]) => values.map(String);
    const wave = Array.from({ length: 60 }, (_, i) => Number((22 + Math.sin(i / 4) * 3).toFixed(2)));
    const noisy = Array.from({ length: 45 }, (_, i) =>
      Number((21 + Math.sin(i) * 0.4 + (i === 30 ? 6 : 0)).toFixed(2)),
    );
    const json = Array.from({ length: 24 }, (_, i) =>
      JSON.stringify({
        temp: Number((21 + Math.sin(i / 3)).toFixed(2)),
        hum: Number((54 + Math.cos(i / 3) * 4).toFixed(1)),
        battery: Number((3.9 - i * 0.004).toFixed(3)),
      }),
    );

    const cases: Array<[string, string, number]> = [
      ['ten readings', shot('sensors/temp', numbers(21.4, 22.1, 23.6, 24.9, 23.2, 21.8, 20.4, 22.7, 25.1, 24.3)), 340],
      ['sixty readings', shot('sensors/temp', wave.map(String)), 340],
      ['the same, wider', shot('sensors/temp', wave.map(String)), 620],
      ['an outlier in the run', shot('sensors/temp', noisy.map(String)), 340],
      ['as a distribution', shot('sensors/temp', wave.map(String), { view: 'dist' }), 340],
      ['a JSON body, three fields', shot('sensors/env', json), 340],
      ['the same, battery picked', shot('sensors/env', json, { field: 'battery' }), 340],
      ['messages it stepped over', shot('sensors/temp', [...numbers(21.4, 22.1), 'sensor warming up', ...numbers(23.6, 24.9, 23.2)]), 340],
      ['a run that never moved', shot('sensors/temp', numbers(21.5, 21.5, 21.5, 21.5, 21.5, 21.5)), 340],
      ['across zero', shot('sensors/drift', numbers(-2.5, -1, 0, 1.75, -0.5, 2, -3.25, 1.5, -2, 0.5, 1, -1.5)), 340],
      ['a narrow pane', shot('sensors/temp', wave.slice(0, 20).map(String)), 250],
      ['big numbers', shot('site/floor2/room14/pressure', numbers(101325, 101390, 101280, 101410, 101350, 101300)), 340],
    ];

    const tokens = readFileSync(`${root}/web/src/styles/tokens.css`, 'utf8');
    const global = readFileSync(`${root}/web/src/styles/global.css`, 'utf8');

    const page = `<!doctype html><meta charset="utf-8"><title>chart preview</title>
<style>${tokens}${global}
  body { background: var(--paper); padding: 24px; display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  section { background: var(--surface); border: 1px solid var(--rule); padding: 14px; }
  h3 { font: 11px var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
</style>
${document.head.innerHTML}
<body>
${cases
  .map(([title, html, width]) => `<section style="width:${width}px"><h3>${title}</h3>${html}</section>`)
  .join('\n')}
</body>`;

    writeFileSync(`${root}/src/MqttForge.Api/wwwroot/chart-preview.html`, page);
  });
});
