import { useId } from 'react';

/**
 * The mark the tool wears, and the name beside it.
 *
 * Drawn on a 24-unit square: a plate in petrol, the wildcard cut through it in paper, and the F
 * of Forge picked out of the same crossing in grey. `#` is the filter a fresh connection
 * subscribes to and the character MQTT actually uses — sheared hard, because at a gentler angle
 * it stops being a diyez and reads as a window grid. The F is the half of the name that is not
 * the protocol, and it is the same six pieces of the crossing every time.
 *
 * It carries its own ground, which the outline mark it replaces deliberately did not. That
 * constraint existed so the mark could sit on white panes without becoming a sticker on the
 * instrument, and it cost a second drawing: an outline for the rail, a solid cut for the favicon
 * and the window list. One drawing that holds at every size beats two that drift apart, so the
 * plate stays and the solid cut is gone.
 *
 * The three colours are literals rather than tokens on purpose. They are the icon's own, not the
 * theme's: the plate has to look the same in the rail, in a browser tab and in the Dock, on
 * whatever ground the host paints behind it.
 *
 * This is the same geometry the desktop icons are cut from, in web/public/favicon.svg. Change one
 * and the other is wrong — edit the favicon, then run `node scripts/make-icons.mjs`.
 */
export function Mark() {
  // The gallery draws this four times on one page, so the clip cannot have a fixed id.
  const plate = useId();

  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={plate}>
          <rect width="24" height="24" rx="5.4" ry="5.4" />
        </clipPath>
      </defs>
      <rect width="24" height="24" rx="5.4" ry="5.4" fill="#0e4260" />
      {/* The arms run past the square on every side and the clip trims them, so the crossing is
          a detail cut from a grid that keeps going rather than a glyph centred in a box. Two of
          the stems cross the rounded corners; without the clip they would poke out of them. */}
      <g clipPath={`url(#${plate})`}>
        <path
          d="M10.91 -2L13.06 -2L11.05 7.2L8.9 7.2ZM17.51 -2L19.66 -2L17.65 7.2L15.5 7.2ZM-2 7.2L8.9 7.2L8.44 9.3L-2 9.3ZM8.9 7.2L11.05 7.2L10.59 9.3L8.44 9.3ZM11.05 7.2L15.5 7.2L15.04 9.3L10.59 9.3ZM8.44 9.3L10.59 9.3L9.41 14.7L7.26 14.7ZM-2 14.7L7.26 14.7L6.8 16.8L-2 16.8ZM7.26 14.7L9.41 14.7L8.95 16.8L6.8 16.8ZM9.41 14.7L13.86 14.7L13.4 16.8L8.95 16.8ZM6.8 16.8L8.95 16.8L6.94 26L4.79 26Z"
          fill="#eaedf1"
        />
        <path
          d="M15.5 7.2L17.65 7.2L17.19 9.3L15.04 9.3ZM17.65 7.2L26 7.2L26 9.3L17.19 9.3ZM15.04 9.3L17.19 9.3L16.01 14.7L13.86 14.7ZM13.86 14.7L16.01 14.7L15.55 16.8L13.4 16.8ZM16.01 14.7L26 14.7L26 16.8L15.55 16.8ZM13.4 16.8L15.55 16.8L13.54 26L11.39 26Z"
          fill="#6b7480"
        />
      </g>
    </svg>
  );
}

/** The name, with the half that carries the mark's colour marked up for the rail to colour. */
export function Wordmark() {
  return (
    <>
      MQTT<span>Forge</span>
    </>
  );
}
