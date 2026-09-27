import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';

/**
 * The import failed — marked here rather than told apart by the error's own words, which every
 * browser writes its own way: Chrome's "Failed to fetch dynamically imported module", Firefox's
 * "error loading dynamically imported module", Safari's "Importing a module script failed". Not
 * named for a fetch failure, because it is not always one: a fault thrown while the chunk's own
 * code first runs — an import cycle, say — rejects the very same import, and is no fetch failure
 * at all. Either way `cause` keeps what the import actually failed with, for the notice to show.
 */
class PageNotLoaded extends Error {
  constructor(cause: unknown) {
    super('The page could not be loaded.', { cause });
  }
}

/**
 * The page is its own chunk. It carries a canvas library the rest of the console has no use for,
 * and a reader who never opens Flows should not download it: this file is the only part of the
 * feature in the main bundle, and it does nothing but name the page and wait for it.
 *
 * The chunk is fetched the first time the panel opens, and that can fail: a tab left open across
 * an update asks for the page under a name the new build no longer has, and a server that has gone
 * answers nothing at all. Asking again when the panel next opens would not bring it: the browser
 * keeps a chunk it could not fetch and answers every later import of it with the same failure,
 * and a browser that did fetch it again would get the page without its stylesheet, which Vite's
 * loader does not ask for a second time. A reload fetches both.
 */
const FlowsPage = lazy(() =>
  import('./FlowsPage').catch((error: unknown) => {
    throw new PageNotLoaded(error);
  }),
);

/** Caught here, whatever goes wrong with the page stays inside the panel instead of taking the console down. */
export function FlowsPanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title="Flows" named stretch onClose={onClose}>
      <ErrorBoundary fallback={(error) => <Stopped error={error} />}>
        <Suspense fallback={<p className={panel.note}>Loading the canvas…</p>}>
          <FlowsPage />
        </Suspense>
      </ErrorBoundary>
    </PanelShell>
  );
}

/**
 * The page did not arrive, or it arrived and stopped on an error. Only the first is about an update
 * or a stopped server; the second says what the error was, so it can be told to somebody rather
 * than reloaded into again and again. Both offer the reload, which starts the page afresh.
 */
function Stopped({ error }: { error: Error }) {
  // Read for a bug report as much as for a reader: worth showing even though the advice above
  // already covers both of what it could mean, because it is the one part of this that says
  // which of the two actually happened here.
  const cause = error instanceof PageNotLoaded && error.cause instanceof Error ? error.cause.message : undefined;

  return (
    <div>
      <p className={panel.fault}>
        {error instanceof PageNotLoaded
          ? 'The page could not be loaded. If the console was updated after this window was opened, a reload fetches the new one; if the server has stopped, start it first.'
          : `The page hit an error: ${error.message}`}
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
