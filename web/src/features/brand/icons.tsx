import type { ReactNode } from 'react';

/**
 * The six marks the panel menu wears, one per panel.
 *
 * Drawn here rather than pulled from an icon set. Six glyphs is not worth a dependency, and a
 * set drawn to its own rules would sit beside the mark in `marks.tsx` looking borrowed: the same
 * 24-unit square, one weight of stroke, round ends, no fill, current colour. That is the whole
 * drawing language of this console, and these follow it — the shapes are Lucide's `antenna`,
 * `funnel`, `chart-line`, `blend`, `qr-code` and `settings`, redrawn at the rail's own weight.
 *
 * 1.8 rather than Lucide's 1.5, because 1.8 is what the mark and every other line in here is
 * drawn at. The one exception is the cog, which has enough going on at sixteen pixels that the
 * heavier stroke closes its teeth up; it keeps 1.5.
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
