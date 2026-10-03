import { Glyph } from '../brand/icons';

/*
 * The node marks, in the rail's drawing language: the same 24-unit square, one weight of stroke,
 * round ends, no fill. Each is the simplest shape that survives fifteen pixels, because that is
 * the size a node wears it at. Raise alarm reuses the rail's own bell, so the node and the panel
 * that lists alarms are plainly about the same thing, and Clear alarm wears that bell struck out.
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

/** Wait: a clock. */
export const ClockGlyph = () => (
  <Glyph>
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  </Glyph>
);

/** Start: where a run begins. */
export const PlayGlyph = () => (
  <Glyph>
    <path d="M8 5.5v13l10-6.5z" />
  </Glyph>
);

/** End: a stop. */
export const StopGlyph = () => (
  <Glyph>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
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

/** For: round again. */
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

/** Set: a value given. */
export const SetGlyph = () => (
  <Glyph>
    <>
      <path d="M5 9h14" />
      <path d="M5 15h14" />
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

/** Clear alarm: a bell with a line through it. */
export const BellOffGlyph = () => (
  <Glyph>
    <>
      <path d="M6 16V11a6 6 0 0 1 9.5-4.9" />
      <path d="M18 11v5l1.5 2H6" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
      <path d="M4 4l16 16" />
    </>
  </Glyph>
);

/** Sound: a speaker. */
export const SpeakerGlyph = () => (
  <Glyph>
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6" />
      <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  </Glyph>
);

/** Notify: a notice. */
export const NoticeGlyph = () => (
  <Glyph>
    <>
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M8 20l3-4" />
      <path d="M8 9.5h8" />
      <path d="M8 12.5h5" />
    </>
  </Glyph>
);

/** Webhook: a post leaving for an address. */
export const HookGlyph = () => (
  <Glyph>
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  </Glyph>
);

/** A node this build does not know: a question. */
export const UnknownGlyph = () => (
  <Glyph>
    <>
      <path d="M9 9a3 3 0 1 1 5.6 1.5c-1 .6-2.6 1.3-2.6 2.7v1" />
      <path d="M12 18v.01" />
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
