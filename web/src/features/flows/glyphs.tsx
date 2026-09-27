import { Glyph } from '../brand/icons';

/*
 * The node marks, in the rail's drawing language: the same 24-unit square, one weight of stroke,
 * round ends, no fill. Each is the simplest shape that survives fifteen pixels, because that is
 * the size a node wears it at. Alarm reuses the rail's own bell, so the node and the panel that
 * lists alarms are plainly about the same thing.
 */

/** MQTT in: a message dropping into a tray. */
export const InGlyph = () => (
  <Glyph>
    <>
      <path d="M12 3v11" />
      <path d="m7 9 5 5 5-5" />
      <path d="M4 16.5V20h16v-3.5" />
    </>
  </Glyph>
);

/** Every: a clock. */
export const ClockGlyph = () => (
  <Glyph>
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  </Glyph>
);

/** Inject: the button it is. */
export const PlayGlyph = () => (
  <Glyph>
    <path d="M8 5.5v13l10-6.5z" />
  </Glyph>
);

/** If: one way in, two ways out. */
export const BranchGlyph = () => (
  <Glyph>
    <>
      <path d="M4 12h6" />
      <path d="M10 12c3 0 4-5 8-5" />
      <path d="M10 12c3 0 4 5 8 5" />
      <path d="m16 5 2 2-2 2" />
      <path d="m16 15 2 2-2 2" />
    </>
  </Glyph>
);

/** For each: a list. */
export const EachGlyph = () => (
  <Glyph>
    <>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  </Glyph>
);

/** Repeat: round again. */
export const RepeatGlyph = () => (
  <Glyph>
    <>
      <path d="M4 11a8 8 0 0 1 13.7-5.6L20 7.5" />
      <path d="M20 3.5v4h-4" />
      <path d="M20 13a8 8 0 0 1-13.7 5.6L4 16.5" />
      <path d="M4 20.5v-4h4" />
    </>
  </Glyph>
);

/** Publish: sent. */
export const SendGlyph = () => (
  <Glyph>
    <>
      <path d="M21 3 10 14" />
      <path d="m21 3-7 18-4-7-7-4z" />
    </>
  </Glyph>
);

/** Debug: a prompt. */
export const DebugGlyph = () => (
  <Glyph>
    <>
      <path d="m5 8 4 4-4 4" />
      <path d="M11 17h8" />
    </>
  </Glyph>
);
