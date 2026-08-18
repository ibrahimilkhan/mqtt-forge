import type { ReactElement } from 'react';

/**
 * The marks the console can wear, and what each of them is about.
 *
 * All six are drawn on the same 24-unit square, in one weight of stroke, in the current text
 * colour with one part in the signal colour. That is not a style choice so much as a constraint:
 * the mark sits at the top of a rail 40 pixels wide when the rail is shut, beside type at 15
 * pixels, on a surface that is white in one theme and near-black in the other. Anything with a
 * fill of its own, a second weight or a colour of its own would be a sticker on the instrument
 * rather than part of it.
 *
 * Which one the tool wears is not something to be decided from the inside, so all of them stay
 * and the choice sits in Settings with the fonts.
 */
export type MarkId = 'anvil' | 'strike' | 'relay' | 'branch' | 'wave' | 'ember';

type Mark = {
  label: string;
  /** What the mark is claiming about the tool, for the reader choosing between them. */
  about: string;
  draw: () => ReactElement;
};

/** Everything is drawn inside this, so the marks stay in proportion to one another. */
const BOX = 24;

const frame = (children: ReactElement) => (
  <svg
    viewBox={`0 0 ${BOX} ${BOX}`}
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
    {children}
  </svg>
);

export const MARKS: Record<MarkId, Mark> = {
  // The tool the name is about. Solid where the others are line work, which makes it the only
  // one that still reads as a shape rather than as a scribble at sixteen pixels.
  anvil: {
    label: 'Anvil',
    about: 'the forge itself — the most literal of the six, and the one that survives smallest',
    draw: () =>
      frame(
        <>
          <path
            d="M3.5 6.5h11l5.5 2.6-5.5 2.6h-1.6l1 5.3h2.1v2.5H8v-2.5h2.1l1-5.3H6.5a3 3 0 0 1-3-3Z"
            fill="currentColor"
            stroke="none"
          />
          {/* The horn, in the signal colour: the working end, and the only part of an anvil
              anyone can name. */}
          <path d="M14.5 6.5 20 9.1l-5.5 2.6Z" fill="var(--signal)" stroke="none" />
        </>,
      ),
  },

  // A hammer landing. Reads as a spark from a foot away and as a broadcast from a desk away,
  // which is the two things the tool does.
  strike: {
    label: 'Strike',
    about: 'a hammer landing, or a message leaving — the same picture either way',
    draw: () =>
      frame(
        <>
          <path d="M12 2.5v3.6M12 17.9v3.6M2.5 12h3.6M17.9 12h3.6" />
          <path d="m5.6 5.6 2.5 2.5M15.9 15.9l2.5 2.5M18.4 5.6l-2.5 2.5M5.6 18.4l2.5-2.5" />
          <circle cx="12" cy="12" r="3.1" fill="var(--signal)" stroke="none" />
        </>,
      ),
  },

  // One publisher, many subscribers, and the broker in the middle of them. The only mark of the
  // six that says what the protocol actually is.
  relay: {
    label: 'Relay',
    about: 'one in, many out — the shape of publish and subscribe',
    draw: () =>
      frame(
        <>
          <circle cx="12" cy="12" r="2.6" fill="var(--signal)" stroke="none" />
          <path d="M16.4 8.2a5.6 5.6 0 0 1 0 7.6" />
          <path d="M19.2 5.1a9.7 9.7 0 0 1 0 13.8" />
          <path d="M7.6 8.2a5.6 5.6 0 0 0 0 7.6" />
          <path d="M4.8 5.1a9.7 9.7 0 0 0 0 13.8" />
        </>,
      ),
  },

  // A topic path, which is the thing a reader of this console spends the day looking at: a trunk
  // with everything hanging off it.
  branch: {
    label: 'Branch',
    about: 'a topic path — the shape the tree in the middle column draws all day',
    draw: () =>
      frame(
        <>
          <path d="M6.5 3.5v13a3 3 0 0 0 3 3h4" />
          <path d="M6.5 9.5h4a3 3 0 0 1 3 3v0" />
          <circle cx="6.5" cy="3.5" r="1.9" fill="currentColor" stroke="none" />
          <circle cx="16.5" cy="12.5" r="1.9" fill="var(--signal)" stroke="none" />
          <circle cx="16.5" cy="19.5" r="1.9" fill="currentColor" stroke="none" />
        </>,
      ),
  },

  // What the right column draws. A square wave rather than a curve: this tool reads switches and
  // pulses as switches and pulses, which is a claim the mark can make on its own.
  wave: {
    label: 'Wave',
    about: 'a signal read as it is — the claim the chart in the right column makes',
    draw: () =>
      frame(
        <>
          <path d="M2.5 17h4V7h5.5v10H17V7h4.5" />
          <circle cx="21.5" cy="7" r="1.9" fill="var(--signal)" stroke="none" />
        </>,
      ),
  },

  // The heat rather than the tool. The warmest of the six, and the only one that would look at
  // home on something that was not an instrument.
  ember: {
    label: 'Ember',
    about: 'the heat rather than the tool — the warmest of the six',
    draw: () =>
      frame(
        <>
          <path d="M12 2.6c.3 3 2 4.3 3.4 5.8 1.6 1.7 2.4 3.1 2.4 5.3a5.8 5.8 0 0 1-11.6 0c0-1.9.7-3.2 1.9-4.4" />
          <path
            d="M12 21c-2 0-3.4-1.4-3.4-3.2 0-2.2 2-2.8 2.5-5.4 1.7 1.4 4.3 3 4.3 5.4A3.3 3.3 0 0 1 12 21Z"
            fill="var(--signal)"
            stroke="none"
          />
        </>,
      ),
  },
};

export const MARK_DEFAULT: MarkId = 'anvil';

/** The tool's name, set the way it is written everywhere else: one word, one half in the signal. */
export function Wordmark() {
  return (
    <>
      MQTT<span>Forge</span>
    </>
  );
}
