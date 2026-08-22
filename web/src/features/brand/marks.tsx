/**
 * The mark the tool wears, and the name beside it.
 *
 * Drawn on a 24-unit square, in one weight of stroke, in the current text colour with one part
 * in the signal colour. That is not a style choice so much as a constraint: the mark sits at the
 * top of a rail 52 pixels wide when the rail is shut, beside type at 15 pixels, over panes that
 * are white. Anything with a fill of its own, a second weight or a colour of its own would be a
 * sticker on the instrument rather than part of it.
 *
 * The mark is the wildcard — `#`, the filter a fresh connection subscribes to — and it is
 * slanted. Upright it is a hashtag or a grid; at 9.2 degrees it is the character MQTT actually
 * uses, and nothing else. The cell inside the crossing is filled, because a joker covering
 * hundreds of topics is still read one topic at a time.
 *
 * Under 16 pixels the filled cell closes and the outline thickens into a blot. `MarkSolid` is
 * the same drawing cut out of a block for those sizes; it keeps its silhouette anywhere.
 */
export function Mark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Four strokes. The verticals lean 2.4 units over their 14.8 of height; the horizontals
          stay level, so the slant reads on its own rather than as a rotation of the whole mark.
          The arms were a unit and a bit longer at each end, and standing on their own — with no
          frame around them to reach towards — they read as a mark drawn past its own crossing.
          Trimmed, the crossing is the shape and the arms are what hold it. */}
      <path d="M10.2 4.6L7.8 19.4M16.2 4.6L13.8 19.4M4.4 9H19.6M4.4 15H19.6" />
      {/* The cell inside the crossing. A parallelogram, since the verticals that bound it lean —
          4.2 units across, which is the smallest shape that still holds a colour at 22 pixels. */}
      <path d="M10.25 9.9H14.43L13.75 14.1H9.57Z" fill="var(--signal)" stroke="none" />
    </svg>
  );
}

/**
 * The same diyez cut out of a solid block, for the sizes and grounds an outline cannot hold: a
 * favicon, a browser tab, a window list, anything under 16 pixels. The cuts stop short of the
 * block's edge, so what is left is one shape with lines through it rather than nine squares.
 */
export function MarkSolid() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="20" height="20" fill="var(--signal)" />
      <path
        d="M10.25 4.2L7.75 19.8M16.25 4.2L13.75 19.8M4.2 9H19.8M4.2 15H19.8"
        fill="none"
        stroke="var(--surface)"
        strokeWidth={1.8}
      />
      <path d="M10.25 9.9H14.43L13.75 14.1H9.57Z" fill="var(--ink)" />
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
