import { createContext } from 'react';

/**
 * What the reader asks of the server from inside the page besides what the toolbar does: a flow
 * deleted, the one thing of the kind there is. It can fail, and the page covers the log, so the page
 * says so — under the tabs, where a deploy that did not go through is said — until it is tried
 * again.
 */
export type Attempt = 'delete';

export type Failures = {
  /** It is being tried again, so whatever it last failed with no longer stands. */
  trying: (attempt: Attempt) => void;
  /**
   * It did not go through, for this reason. The line stays whichever flow is on screen, so it names
   * the flow it was about.
   */
  failed: (attempt: Attempt, flowId: string, error: unknown) => void;
};

/**
 * The page's, handed to the inspector. Held by the page as its own state, like the deploy it sits
 * beside: a page opened again starts with nothing to say. Without a page around it, nobody is told
 * but the log.
 */
export const Failures = createContext<Failures>({ trying: () => {}, failed: () => {} });
