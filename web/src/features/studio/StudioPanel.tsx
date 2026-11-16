import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';

/** The import failed — told apart by type, not by each browser's own words. See FlowsPanel for the long version. */
class PageNotLoaded extends Error {
  constructor(cause: unknown) {
    super('The studio could not be loaded.', { cause });
  }
}

/**
 * The studio is its own chunk, and the heaviest in the console: it carries Babylon. This file is
 * all of it the main bundle holds, so a reader who never opens 3D Studio never downloads an engine.
 * The chunk-failure reasoning is FlowsPanel's — a stale tab, a stopped server, and a browser that
 * caches a failed import — and so is the answer: a reload.
 */
const StudioPage = lazy(() =>
  import('./StudioPage').catch((error: unknown) => {
    throw new PageNotLoaded(error);
  }),
);

export function StudioPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title="3D Studio" named stretch onClose={onClose}>
      <ErrorBoundary fallback={(error) => <Stopped error={error} />}>
        <Suspense fallback={<p className={panel.note}>Loading the studio…</p>}>
          <StudioPage />
        </Suspense>
      </ErrorBoundary>
    </PanelShell>
  );
}

function Stopped({ error }: { error: Error }) {
  const cause = error instanceof PageNotLoaded && error.cause instanceof Error ? error.cause.message : undefined;

  return (
    <div>
      <p className={panel.fault}>
        {error instanceof PageNotLoaded
          ? 'The studio could not be loaded. If the console was updated after this window was opened, a reload fetches the new one; if the server has stopped, start it first.'
          : `The studio hit an error: ${error.message}`}
      </p>
      {cause && <p className={panel.note}>{cause}</p>}
      <div className={panel.actions}>
        <button type="button" onClick={() => window.location.reload()}>
          Reload the console
        </button>
      </div>
    </div>
  );
}
