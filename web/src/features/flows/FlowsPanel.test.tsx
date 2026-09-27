import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import panel from '../../styles/panel.module.css';

/** Whether the page's chunk arrives when the panel asks for it. */
const chunk = { arrives: false };

/**
 * The panel as a console that has not asked for the page yet has it, and a page that either does
 * not arrive or arrives and fails while it draws. Not arriving is what a tab left open across an
 * update meets: the page's chunk has a new name in the new build, and the one this tab asks for is
 * gone. In Firefox's words, not Chrome's: the panel is not to depend on either.
 *
 * Mocked afresh for each test, because a page that arrived once is kept by the mock for the rest
 * of the file.
 */
async function freshPanel() {
  vi.resetModules();
  vi.doMock('./FlowsPage', () => {
    if (!chunk.arrives) throw new TypeError('error loading dynamically imported module: /assets/FlowsPage-CaOaZmu6.js');
    return {
      default: function FlowsPage(): never {
        throw new Error('The canvas lost its place.');
      },
    };
  });
  return (await import('./FlowsPanel')).FlowsPanel;
}

// React reports the error it caught, and the boundary logs it; neither is what this is about.
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('Flows panel', () => {
  it('says the page could not be loaded, and offers to reload the console', async () => {
    chunk.arrives = false;
    const FlowsPanel = await freshPanel();
    render(<FlowsPanel onClose={() => {}} />);

    expect(
      await screen.findByText(/^The page could not be loaded\. If the console was updated after this window was opened/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the console' })).toBeInTheDocument();
    // Only the page failed. The panel around it still has its name and its way out.
    expect(screen.getByRole('heading', { name: 'Flows' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Flows panel' })).toBeInTheDocument();
  });

  // A fault in the page is not an update or a stopped server. Blamed on either, it would send the
  // reader to reload into the same fault, and never say what it was.
  it('says what went wrong when the page stops on an error of its own, and still offers the reload', async () => {
    chunk.arrives = true;
    const FlowsPanel = await freshPanel();
    render(<FlowsPanel onClose={() => {}} />);

    expect(await screen.findByText('The page hit an error: The canvas lost its place.')).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the console' })).toBeInTheDocument();
  });

  // Asking again would not bring it. The browser keeps a chunk it failed to fetch and answers every
  // later import of it with the same failure, without a request; and where one did fetch it again,
  // the page would come without its stylesheet, which Vite's loader does not ask for twice. Only a
  // reload fetches both again.
  it('says the same when it is opened again after the page could not be loaded', async () => {
    chunk.arrives = false;
    const FlowsPanel = await freshPanel();
    const first = render(<FlowsPanel onClose={() => {}} />);
    await screen.findByText(/The page could not be loaded/);
    first.unmount();

    chunk.arrives = true;
    render(<FlowsPanel onClose={() => {}} />);

    expect(await screen.findByText(/The page could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the console' })).toBeInTheDocument();
  });

  // An import cycle throws while the chunk's own code first runs, which rejects the dynamic
  // import exactly as a fetch failure does — so the advice above cannot say which one happened,
  // and still does not. But the words the failure came with say a good deal on their own, to a
  // reader who wants to know more or a bug report that should have them. Not pinned to a literal
  // string: like the advice above, which browser or bundler said it is not this test's business,
  // only that whatever it was is there, under the notice, in the same voice the console uses for
  // anything it only wants to add rather than to warn with.
  it('shows the underlying error under the notice, in the muted voice it is said in', async () => {
    chunk.arrives = false;
    const FlowsPanel = await freshPanel();
    render(<FlowsPanel onClose={() => {}} />);

    const notice = await screen.findByText(/^The page could not be loaded\./);
    // Its own paragraph, right after the advice, not folded into it: the two are read as
    // separate sentences, one said flatly and one said quieter.
    const cause = notice.nextElementSibling;

    expect(cause).toHaveClass(panel.note);
    expect(cause?.textContent).not.toBe('');
    expect(cause?.textContent).not.toBe(notice.textContent);
  });
});
