/**
 * The mark the tool wears, and the name beside it.
 *
 * Drawn on a 24-unit square, in one weight of stroke, in the current text colour with one part
 * in the signal colour. That is not a style choice so much as a constraint: the mark sits at the
 * top of a rail 46 pixels wide when the rail is shut, beside type at 15 pixels, over panes that
 * are white. Anything with a fill of its own, a second weight or a colour of its own would be a
 * sticker on the instrument rather than part of it.
 *
 * There were six of these, and which one the tool wore sat in Settings beside the fonts. Six
 * marks is six answers to a question a tool should answer once — and a reader choosing one is a
 * reader being asked to do the work of naming the thing they came to use. This is the answer:
 * the ember. Not the anvil and not the hammer, because what a forge is *for* is the heat, and
 * heat is the one thing here that is also what the tool watches — a topic that is alive.
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
      {/* The outer flame in the page's own ink, and the inner one — the part that is actually
          hot — in the signal colour. Two shapes, so the mark still reads at sixteen pixels,
          where a single outline of a flame reads as a leaf. */}
      <path d="M12 2.6c.3 3 2 4.3 3.4 5.8 1.6 1.7 2.4 3.1 2.4 5.3a5.8 5.8 0 0 1-11.6 0c0-1.9.7-3.2 1.9-4.4" />
      <path
        d="M12 21c-2 0-3.4-1.4-3.4-3.2 0-2.2 2-2.8 2.5-5.4 1.7 1.4 4.3 3 4.3 5.4A3.3 3.3 0 0 1 12 21Z"
        fill="var(--signal)"
        stroke="none"
      />
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
