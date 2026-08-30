import type { ReactNode } from 'react';

/**
 * The six marks the panel menu wears, one per panel — and twelve more that are not panels.
 *
 * Drawn here rather than pulled from an icon set. Twelve glyphs is not worth a dependency, and a
 * set drawn to its own rules would sit beside the mark in `marks.tsx` looking borrowed: the same
 * 24-unit square, one weight of stroke, round ends, no fill, current colour. That is the whole
 * drawing language of this console, and these follow it — the shapes are Lucide's `antenna`,
 * `funnel`, `chart-line`, `blend`, `qr-code` and `settings`, redrawn at the rail's own weight.
 *
 * 1.8 rather than Lucide's 1.5, because 1.8 is what the mark and every other line in here is
 * drawn at. The one exception is the cog, which has enough going on at sixteen pixels that the
 * heavier stroke closes its teeth up; it keeps 1.5.
 *
 * `Warning` wears no panel: it stands on the Broker row beside `Antenna`, and a triangle
 * borrowed from somewhere else would look stuck on rather than part of the rail.
 *
 * The last ten wear no panel either — they go inside buttons, in the same mono the button is
 * lettered in, at the size of one line of that type. Which is what they are drawn for: a mark in
 * a button has one line of type's worth of room and has to be recognised in it, so each of them
 * is the simplest shape that survives thirteen pixels.
 */
const Glyph = ({ children, weight = 1.8 }: { children: ReactNode; weight?: number }) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth={weight}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

/** Broker: what the console is listening to, drawn as the thing that listens. */
export const Antenna = () => (
  <Glyph>
    <>
      <circle cx="12" cy="12" r="1.5" />
      <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6" />
      <path d="M15.8 15.8a5.4 5.4 0 0 0 0-7.6" />
      <path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4" />
      <path d="M18.7 18.7a9.5 9.5 0 0 0 0-13.4" />
    </>
  </Glyph>
);

/** Filters: everything the broker has, narrowed to what was asked for. */
export const Funnel = () => (
  <Glyph>
    <path d="M3.8 5h16.4l-6.4 7.7v6.1l-3.6-2v-4.1Z" />
  </Glyph>
);

/** Chart: a run of readings, which is what the panel sets the shape of. */
export const ChartLine = () => (
  <Glyph>
    <>
      <path d="M4 4v16h16" />
      <path d="m7.6 15.2 3.4-4.6 3 2.6 4.4-6.2" />
    </>
  </Glyph>
);

/** Colours: two inks meeting, since a rule is a colour laid over a filter. */
export const Blend = () => (
  <Glyph>
    <>
      <circle cx="9.6" cy="12" r="6" />
      <circle cx="14.4" cy="12" r="6" />
    </>
  </Glyph>
);

/** QR: the code itself, three corners and a scrap of payload. */
export const QrCode = () => (
  <Glyph>
    <>
      <rect x="3.6" y="3.6" width="6" height="6" rx="0.6" />
      <rect x="14.4" y="3.6" width="6" height="6" rx="0.6" />
      <rect x="3.6" y="14.4" width="6" height="6" rx="0.6" />
      <path d="M14.4 14.4h2.6v2.6" />
      <path d="M20.4 20.4h-3.4" />
    </>
  </Glyph>
);

/** Settings: the cog, at the lighter weight its teeth need. */
export const Settings = () => (
  <Glyph weight={1.5}>
    <>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </>
  </Glyph>
);

/**
 * Something went wrong with the link.
 *
 * Beside the Broker row rather than instead of it. The colour of the antenna already says
 * connected or not; this says that the last thing that happened was a failure, which a colour
 * cannot say to everyone and cannot say at all to somebody who has not learnt what green means
 * here yet.
 */
export const Warning = () => (
  <Glyph>
    <>
      <path d="M12 4.2 21 19.5H3z" />
      <path d="M12 10v4" />
      <path d="M12 16.6v.1" />
    </>
  </Glyph>
);

/**
 * Keep this one.
 *
 * A disk, which is the mark for saving everywhere and has been since long after anybody last
 * used one. Lucide's `save`, redrawn at this file's weight: the body with its cut corner, the
 * label across the foot, the shutter at the head. Its one job is to be recognised at the size of
 * a line of type, and the three shapes are what does that — a plain rounded square at 13px is a
 * plain rounded square.
 */
export const Save = () => (
  <Glyph>
    <>
      <path d="M4.2 3.4h10.6l4.8 4.8v11.4a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 19.6V4.6a1.2 1.2 0 0 1 1.2-1.2z" />
      <path d="M16.6 20.8v-6.4H7.4v6.4" />
      <path d="M7.4 3.4v4.4h6.2" />
    </>
  </Glyph>
);

/**
 * The link, joined — and the link, broken.
 *
 * One shape and the same shape with a stroke taken out of it, which is what connecting and
 * disconnecting are. This console calls the connection 'the link' in every line it has ever
 * written about it, so a chain link is not a metaphor here, it is the word.
 *
 * Lucide's `link-2` and `unlink-2`, redrawn wider than Lucide draws them: theirs sits inside the
 * middle ten units of the square and would read as a smaller mark than the disk beside it.
 *
 * `Unlink`'s tails are shorter than `Link`'s. They have to be — the break is the whole of the
 * difference between the two, and at thirteen pixels a three-unit gap is a pixel and a half.
 * The two are never on screen together, so what each has to do is read as the link on its own.
 */
export const Link = () => (
  <Glyph>
    <>
      <path d="M10.5 17.5H8a5.5 5.5 0 0 1 0-11h2.5" />
      <path d="M13.5 6.5H16a5.5 5.5 0 0 1 0 11h-2.5" />
      <path d="M9.5 12h5" />
    </>
  </Glyph>
);

export const Unlink = () => (
  <Glyph>
    <>
      <path d="M9.5 17.5H8a5.5 5.5 0 0 1 0-11h1.5" />
      <path d="M14.5 6.5H16a5.5 5.5 0 0 1 0 11h-1.5" />
    </>
  </Glyph>
);

/**
 * Call it off.
 *
 * A cross, which is the one mark that needs no explaining at any size — and the reason the panel
 * draws its close button as a character rather than a glyph is the same reason this one is two
 * strokes: there is nothing else it could be.
 *
 * It exists because Abort stands in Connect's place while an attempt runs, and a button that
 * swapped a marked word for a bare one would change width in the reader's hand. See .steadyLabel
 * for the other half of holding that still.
 */
export const Cross = () => (
  <Glyph>
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  </Glyph>
);

/**
 * Open this one out.
 *
 * Lucide's `maximize-2` — two corners pushed apart, which is what enlarging is. No arrowheads:
 * six strokes is what survives thirteen pixels, and the heads would be the first thing to close
 * up. Pulled a unit inside the square the way Cross is, so it sits at the weight of the marks
 * beside it rather than filling more of its box than they do.
 */
export const Expand = () => (
  <Glyph>
    <>
      <path d="M14.5 4H20v5.5" />
      <path d="M9.5 20H4v-5.5" />
      <path d="M20 4l-6.5 6.5" />
      <path d="M4 20l6.5-6.5" />
    </>
  </Glyph>
);

/**
 * Take a copy of this.
 *
 * Lucide's `copy` — one sheet behind another, which is the oldest picture of it there is and the
 * only one that reads at thirteen pixels without a caption. Drawn at the square's own weight; the
 * back sheet is an open path rather than a second rectangle, because two closed boxes overlapping
 * put four corners in the same few pixels and closed them into a blot.
 */
export const Copy = () => (
  <Glyph>
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1" />
    </>
  </Glyph>
);

/**
 * It worked.
 *
 * Two strokes, and it stands in the copy mark's place for a moment after a copy. A word would
 * have changed the button's width in the hand that had just pressed it — see Cross and
 * .steadyLabel for the same problem solved the same way one panel over.
 */
export const Check = () => (
  <Glyph>
    <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
  </Glyph>
);

/**
 * Put it back.
 *
 * Expand's own construction, mirrored: the same two corners and the same two diagonals, with the
 * elbows moved inside and the lines running out to the square's corners rather than in from them.
 * Lucide's `minimize-2`. Drawn from Expand rather than copied from the set, because these two sit
 * in the same place in the same bar one press apart, and a pair that is not exactly a pair reads
 * as a control that changed into a different control.
 */
export const Shrink = () => (
  <Glyph>
    <>
      <path d="M20 9.5h-5.5V4" />
      <path d="M4 14.5h5.5V20" />
      <path d="M20 4l-5.5 5.5" />
      <path d="M4 20l5.5-5.5" />
    </>
  </Glyph>
);

/**
 * Open every branch of it, and shut every branch of it.
 *
 * Lucide's `chevrons-up-down` and `chevrons-down-up`, and they are a pair in the strictest sense:
 * the same two chevrons, one set pointing away from the middle and one pointing into it. Which is
 * what the two gestures are — everything out, everything in — and it is the only pair of marks in
 * here a reader has to tell apart at a glance while their eye is on something else.
 *
 * They stand where 'expand all' and 'collapse all' stood in words. Two words of eleven characters
 * over a document is a caption on the document rather than a control beside it.
 */
export const Unfold = () => (
  <Glyph>
    <>
      <path d="M8 9.5 12 5.5 16 9.5" />
      <path d="M8 14.5 12 18.5 16 14.5" />
    </>
  </Glyph>
);

export const Fold = () => (
  <Glyph>
    <>
      <path d="M8 5.5 12 9.5 16 5.5" />
      <path d="M8 18.5 12 14.5 16 18.5" />
    </>
  </Glyph>
);

/**
 * Out of the console and onto the disk.
 *
 * Lucide's `download` — an arrow into a tray, which is the one picture of saving that has never
 * meant anything else. It stands in front of the word rather than instead of it: 'csv' says what
 * the file is and the mark says what the button does, and neither of those is the other.
 */
export const Download = () => (
  <Glyph>
    <>
      <path d="M12 3.5v11" />
      <path d="M7.5 10 12 14.5 16.5 10" />
      <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
    </>
  </Glyph>
);

/**
 * The corner a window is sized by.
 *
 * Three diagonals stacked into the bottom-right — the grow box every window manager has drawn
 * since there were grow boxes, and the one mark here nobody has to be taught. They run square to
 * the drag, and that is the whole difference: the corner used to be two hairlines lying along the
 * window's own two edges, which say where the window ends. The frame was already saying that,
 * which is why nobody found the handle. A comb across the pull says take hold.
 *
 * No arrowhead, for the reason Expand has none: at thirteen pixels a head is three pixels of
 * mush. The taper does that work instead — three strokes shortening into a corner are a shape,
 * where three of one length are a hatch.
 */
export const Corner = () => (
  <Glyph>
    <>
      <path d="M20.5 7 7 20.5" />
      <path d="M20.5 12.5 12.5 20.5" />
      <path d="M20.5 18 18 20.5" />
    </>
  </Glyph>
);
