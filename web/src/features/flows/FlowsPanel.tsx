import { lazy, Suspense } from 'react';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';

/**
 * The page is its own chunk. It carries a canvas library the rest of the console has no use for,
 * and a reader who never opens Flows should not download it: this file is the only part of the
 * feature in the main bundle, and it does nothing but name the page and wait for it.
 */
const FlowsPage = lazy(() => import('./FlowsPage'));

export function FlowsPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title="Flows" named stretch onClose={onClose}>
      <Suspense fallback={<p className={panel.note}>Loading the canvas…</p>}>
        <FlowsPage />
      </Suspense>
    </PanelShell>
  );
}
