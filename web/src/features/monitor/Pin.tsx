/**
 * The mark on the control that keeps a chart on screen.
 *
 * A drawing pin seen head-on would be a dot, and seen from the side it is a shape nothing else
 * in this console could be mistaken for: a head, a shaft, and the point it stands on. Drawn on
 * the same 16-unit square as the corner marks beside it, in the current text colour, so the
 * control's own state colours it.
 */
export function Pin() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M6 2h4M8 2v5M4.5 10.5h7L10 7H6L4.5 10.5ZM8 10.5V14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
