import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';

/**
 * The page is its own chunk. It carries a canvas library the rest of the console has no use for,
 * and a reader who never opens Flows should not download it: this file is the only part of the
 * feature in the main bundle, and it does nothing but name the page and wait for it.
 */
const FlowsPage = lazy(() => import('./FlowsPage'));

/**
 * The chunk is fetched the first time the panel opens, and that can fail: a tab left open across
 * an update asks for the page under a name the new build no longer has, and a server that has gone
 * answers nothing at all. Caught here, the failure stays inside the panel instead of taking the
 * console down with it. Trying again would not help — React keeps the failed import — so what is
 * offered is a reload, which asks for the console as it is now.
 */
export function FlowsPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title="Flows" named stretch onClose={onClose}>
      <ErrorBoundary fallback={() => <NotLoaded />}>
        <Suspense fallback={<p className={panel.note}>Loading the canvas…</p>}>
          <FlowsPage />
        </Suspense>
      </ErrorBoundary>
    </PanelShell>
  );
}

function NotLoaded() {
  return (
    <div>
      <p className={panel.fault}>
        The page could not be loaded. If the console was updated after this tab was opened, reloading it fetches the new
        one; if the server has stopped, start it first.
      </p>
      <div className={panel.actions}>
        <button type="button" onClick={() => window.location.reload()}>
          Reload the console
        </button>
      </div>
    </div>
  );
}
