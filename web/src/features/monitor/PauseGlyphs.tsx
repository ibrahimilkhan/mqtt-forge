import type { ReactElement } from 'react';

/**
 * Drawn rather than typed: the characters for these are in the emoji block, and a font that has
 * them renders a pair of coloured lozenges in a row of 10px mono type. Twelve units square, in
 * the current text colour, so each control's own state colours them.
 *
 * Shared, because there are two pauses now and they must be the same two shapes: one stops the
 * console taking messages in, the other stops a pane redrawing, and a reader should not have to
 * learn a second vocabulary for the second one.
 */
const Icon = ({ children }: { children: ReactElement }) => (
  <svg viewBox="0 0 12 12" width="1.05em" height="1.05em" fill="currentColor" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export const Pause = () => (
  <Icon>
    <>
      <rect x="2.5" y="1.5" width="2.6" height="9" rx="0.6" />
      <rect x="6.9" y="1.5" width="2.6" height="9" rx="0.6" />
    </>
  </Icon>
);

export const Play = () => (
  <Icon>
    <path d="M3 1.8 10 6 3 10.2Z" />
  </Icon>
);
